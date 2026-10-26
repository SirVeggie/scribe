/**
 * The agent harness view (#456): a full panel on what every chat is given at its start (Scribe's
 * instructions and tools, MCP servers, skills, memories) and how the stored threads used it. What
 * Scribe manages is changed here too (#495): MCP servers, skills, memories, hooks and instruction
 * files. This is the one place for Scribe's MCP list (#823); its dialogs and the hook rules are
 * agent.js's own, opened over or mounted in this panel.
 */
(() => {
  const PROVIDERS = ["cursor", "claude", "codex", "pi"];
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor", codex: "Codex", pi: "Native" };
  /** How a thread runs, which follows its rung (#719). Older samples can still say ask. */
  const MODE_LABEL = { code: "Code", plan: "Plan", board: "Board" };
  const KIND_LABEL = { execute: "Shell commands", mcp: "MCP tools", read: "File reads", search: "Searches", edit: "File edits", fetch: "Web", think: "Thinking", task: "Subagents", todo: "To-dos", delete: "Deletes", move: "Moves", other: "Other" };
  const RANGES = [
    { id: 7, label: "7 days" },
    { id: 30, label: "30 days" },
    { id: 90, label: "90 days" },
    { id: 0, label: "All" },
  ];
  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "context", label: "Session context" },
    { id: "tools", label: "Tool use" },
    { id: "mcp", label: "MCP servers" },
    { id: "skills", label: "Skills" },
    { id: "modes", label: "Modes" },
    { id: "hooks", label: "Hooks" },
    { id: "memories", label: "Memories" },
    { id: "threads", label: "Heaviest threads" },
  ];
  const LS = { days: "scribe.harness.days", section: "scribe.harness.section", pick: "scribe.harness.pick" };

  const S = {
    section: localStorage.getItem(LS.section) || "overview",
    days: Number(localStorage.getItem(LS.days) ?? 30),
    pick: { provider: "claude", mode: "code", cwd: null },
    stats: null,
    context: null,
    skills: null,
    skillFolders: [],
    config: null,
    threads: [],
    measure: null,
    probes: new Map(),
    /** Scribe's MCP file ({ path, error?, file }) and servers found in Claude Code's config. */
    mcp: null,
    mcpFound: [],
    mcpFoundError: "",
    error: "",
    loading: 0,
    contextLoading: 0,
  };
  try {
    Object.assign(S.pick, JSON.parse(localStorage.getItem(LS.pick) || "{}"));
  } catch {
    /* keep the defaults */
  }

  let root, body, heading, controls, nav, renderedSection, hooksNode;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const node = el("button", cls, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  async function api(method, path, payload) {
    const write = method !== "GET";
    const res = await fetch(`/api/agent${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(payload ?? {}) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  const chat = () => window.scribeChat;
  const notice = (text) => window.scribeApp?.showNotice?.(text);
  const dirKey = (dir) => String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const cwdQuery = (lead) => (S.pick.cwd ? `${lead}cwd=${encodeURIComponent(S.pick.cwd)}` : "");

  function switchButton(on, label, toggle) {
    const node = button("", "pill-toggle", () => {
      node.disabled = true;
      toggle();
    });
    node.setAttribute("role", "switch");
    node.setAttribute("aria-checked", String(on));
    node.setAttribute("aria-label", label);
    return node;
  }

  function field(label, input, hint) {
    const wrap = el("label", "ag-field");
    // A themed picker stands in for its hidden select.
    const box = input.parentElement?.classList.contains("select-wrap") ? input.parentElement : input;
    wrap.append(el("span", "ag-field-label", label), box);
    if (hint) wrap.append(el("span", "ag-muted ag-field-hint", hint));
    return wrap;
  }

  /** Who reads a folder of skills. */
  function folderLabel(folder) {
    return `${folder.providers.map((provider) => PROVIDER_LABEL[provider]).join(", ")}, ${folder.scope === "user" ? "everywhere" : "this workspace"}`;
  }

  function folderSelect(folders, label) {
    const select = el("select");
    select.setAttribute("aria-label", label);
    for (const folder of folders) select.append(new Option(`${folderLabel(folder)} · ${folder.dir}`, folder.dir));
    themed(select);
    return select;
  }

  /** Swaps a native select for the app's themed picker and returns the wrapper (call syncSelect on it after setting value). */
  function themed(select) {
    const wrap = window.createSelect ? window.createSelect(select) : select;
    wrap.classList.add("hx-select");
    return wrap;
  }

  function tokens(n) {
    if (!n) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }

  const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
  const count = (n) => Number(n || 0).toLocaleString();

  function duration(ms) {
    if (!ms) return "–";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.round(ms / 60_000)} min`;
  }

  /* ---------- pieces ---------- */

  function card(title, hint) {
    const node = el("section", "hx-card");
    if (title) node.append(el("h3", null, title));
    if (hint) node.append(el("p", "hx-hint", hint));
    return node;
  }

  function tiles(list) {
    const row = el("div", "hx-tiles");
    for (const [label, value, note, tip] of list) {
      const tile = el("div", "hx-tile");
      tile.append(el("span", "hx-tile-label", label), el("strong", "hx-tile-value", value));
      if (note) tile.append(el("span", "hx-tile-note", note));
      if (tip) {
        tile.dataset.tooltip = tip;
        tile.setAttribute("aria-description", tip);
        tile.tabIndex = 0;
      }
      row.append(tile);
    }
    return row;
  }

  /** rows: [{ label, sub?, value, text, tone?, detail? }], drawn as one bar each against the largest value. */
  function bars(rows, { max } = {}) {
    const list = el("div", "hx-bars");
    const top = max ?? Math.max(1, ...rows.map((row) => row.value));
    for (const row of rows) {
      const line = el(row.detail ? "details" : "div", "hx-bar-row");
      const head = el(row.detail ? "summary" : "div", "hx-bar-head");
      const label = el("span", "hx-bar-label");
      label.append(el("span", null, row.label));
      if (row.sub) label.append(el("span", "hx-muted", ` ${row.sub}`));
      const track = el("span", "hx-bar-track");
      const fill = el("span", `hx-bar-fill${row.tone ? ` ${row.tone}` : ""}`);
      fill.style.width = `${Math.max(row.value > 0 ? 0.6 : 0, (row.value / top) * 100)}%`;
      track.append(fill);
      head.append(label, track, el("span", "hx-bar-value", row.text));
      if (row.tip) head.dataset.tooltip = row.tip;
      line.append(head);
      if (row.detail) line.append(el("pre", "hx-pre", row.detail));
      list.append(line);
    }
    return list;
  }

  /** columns: [{ label, num?, get(row) -> string | Node }] */
  function table(columns, rows, { onRow } = {}) {
    const node = el("table", "hx-table");
    const head = el("tr");
    for (const column of columns) head.append(el("th", column.num ? "num" : null, column.label));
    node.appendChild(el("thead")).append(head);
    const tbody = node.appendChild(el("tbody"));
    for (const row of rows) {
      const tr = el("tr");
      for (const column of columns) {
        const cell = el("td", column.num ? "num" : null);
        const value = column.get(row);
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value ?? "";
        tr.append(cell);
      }
      if (onRow) {
        tr.classList.add("hx-row-link");
        tr.tabIndex = 0;
        tr.addEventListener("click", () => onRow(row));
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter") onRow(row);
        });
      }
      tbody.append(tr);
    }
    const wrap = el("div", "hx-table-wrap");
    wrap.append(node);
    return wrap;
  }

  function providerChip(provider) {
    const chip = el("span", "hx-provider");
    chip.append(el("i", `hx-dot hx-p-${provider}`), document.createTextNode(PROVIDER_LABEL[provider] || provider));
    return chip;
  }

  function empty(text) {
    return el("p", "hx-empty", text);
  }

  function track(options, current, onPick, label) {
    const node = el("div", "button-track text-track");
    node.setAttribute("role", "group");
    if (label) node.setAttribute("aria-label", label);
    for (const option of options) {
      const control = button(option.label, null, () => onPick(option.id));
      control.setAttribute("aria-pressed", String(option.id === current));
      node.append(control);
    }
    return node;
  }

  /* ---------- sections ---------- */

  function rangeText() {
    return S.days ? `the last ${S.days} days` : "all stored threads";
  }

  function costStatus(u) {
    if (!u.pricedTurns) return "Unknown";
    return u.costPartial || u.unpricedTurns ? "Partial" : u.estimatedCostUsd === u.costUsd && u.reportedCostUsd === undefined ? "Estimated" : u.reportedCostUsd === u.costUsd && u.estimatedCostUsd === undefined ? "Provider-reported" : "Recorded";
  }

  function costText(cost) {
    if (typeof cost === "object" && cost) {
      const u = cost;
      if (!u.pricedTurns) return "Unknown";
      return `${costStatus(u)} ${costText(u.costUsd)}` + (u.unpricedTurns ? ` · ${count(u.unpricedTurns)} unpriced ${u.unpricedTurns === 1 ? "turn" : "turns"}` : "");
    }
    if (cost > 0 && cost < 0.0001) return "<$0.0001";
    return typeof cost === "number" ? `$${cost.toFixed(cost < 0.01 ? 4 : cost < 0.1 ? 3 : 2)}` : "–";
  }

  function renderOverview() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    if (!stats.totals.turns) return [empty(`No turns in ${rangeText()}.`)];
    const t = stats.totals;
    const out = [];
    out.push(
      tiles([
        ["Threads", count(stats.threads)],
        ["Turns", count(t.turns), `${count(stats.outcomes.error)} failed · ${count(stats.outcomes.cancelled)} stopped`],
        ["Sent to models", tokens(t.prompt), `${pct(t.cached, t.prompt)} read from cache`],
        ["Written by models", tokens(t.output), t.reasoning ? `${tokens(t.reasoning)} reasoning` : ""],
        ["Tool calls", count(t.toolCalls), `${(t.toolCalls / Math.max(1, t.turns)).toFixed(1)} a turn · ${pct(t.toolErrors, t.toolCalls)} failed`],
        ["Cost", t.pricedTurns ? costText(t.costUsd) : "Unknown", t.pricedTurns ? costStatus(t) : "", `${costText(t)}\n${count(t.unpricedTurns)} unpriced turns\nEstimated: ${costText(t.estimatedCostUsd)}\nProvider-reported: ${costText(t.reportedCostUsd)}`],
      ])
    );

    const daily = card("Tokens sent to models, by day", "Everything each turn sent, cached input included. A turn sends its whole conversation again on every model call, so long tool loops dominate.");
    daily.append(dayChart(stats.days));
    out.push(daily);

    const providers = card("By provider", "Model responses count observed main-thread replies, excluding hidden retries and provider subagents. The average covers only turns with response counts.");
    providers.append(
      table(
        [
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Threads", num: true, get: (r) => count(r.threads) },
          { label: "Turns", num: true, get: (r) => count(r.turns) },
          { label: "Responses a turn", num: true, get: (r) => r.modelCallTurns ? (r.modelCalls / r.modelCallTurns).toFixed(1) : "–" },
          { label: "Turns counted", num: true, get: (r) => `${count(r.modelCallTurns || 0)} / ${count(r.turns)}` },
          { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
          { label: "Cached", num: true, get: (r) => pct(r.cached, r.prompt) },
          { label: "Sent a turn", num: true, get: (r) => tokens(r.prompt / Math.max(1, r.turns)) },
          { label: "Written", num: true, get: (r) => tokens(r.output) },
          { label: "Tools a turn", num: true, get: (r) => (r.toolCalls / Math.max(1, r.turns)).toFixed(1) },
          { label: "Tools failed", num: true, get: (r) => pct(r.toolErrors, r.toolCalls) },
          { label: "Turns failed", num: true, get: (r) => pct(r.errors, r.turns) },
          { label: "Cost", num: true, get: (r) => costText(r) },
        ],
        stats.providers
      )
    );
    out.push(providers);

    const models = card("By model");
    models.append(
      table(
        [
          { label: "Model", get: (r) => r.model },
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Turns", num: true, get: (r) => count(r.turns) },
          { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
          { label: "Cached", num: true, get: (r) => pct(r.cached, r.prompt) },
          { label: "Written", num: true, get: (r) => tokens(r.output) },
          { label: "Tools a turn", num: true, get: (r) => (r.toolCalls / Math.max(1, r.turns)).toFixed(1) },
          { label: "Cost", num: true, get: (r) => costText(r) },
        ],
        stats.models
      )
    );
    out.push(models);

    const base = card(
      "What a session starts with, measured",
      "The first model response's input, including cached tokens and your message. Older turns without response measurements contribute their total input only when they made no tool call. Forks are excluded."
    );
    base.append(
      stats.baselines.length
        ? table(
            [
              { label: "Provider", get: (r) => providerChip(r.provider) },
              { label: "Mode", get: (r) => MODE_LABEL[r.mode] || r.mode },
              { label: "Typical first call", num: true, get: (r) => tokens(r.median) },
              { label: "Smallest", num: true, get: (r) => tokens(r.min) },
              { label: "Turns measured", num: true, get: (r) => count(r.samples) },
            ],
            stats.baselines
          )
        : empty("No first-prompt samples in this range yet.")
    );
    out.push(base);
    return out;
  }

  /** Stacked columns: one per day, a segment per provider, drawn in SVG with a hover tooltip per day. */
  function dayChart(days) {
    const wrap = el("div", "hx-chart");
    const shown = days.slice(-60);
    const total = (day) => PROVIDERS.reduce((sum, p) => sum + (day.prompt[p] || 0), 0);
    const max = Math.max(1, ...shown.map(total));
    const W = 960;
    const H = 180;
    const slot = W / Math.max(shown.length, 14);
    const width = Math.max(3, Math.min(34, slot - 2));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H + 22}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Tokens sent to models by day and provider");
    const make = (name, attrs) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      return node;
    };
    for (const share of [0.5, 1]) {
      const y = H - H * share;
      svg.append(make("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "hx-grid" }));
      const label = make("text", { x: W, y: y + 12, class: "hx-axis", "text-anchor": "end" });
      label.textContent = tokens(max * share);
      svg.append(label);
    }
    svg.append(make("line", { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: "hx-base" }));
    shown.forEach((day, index) => {
      const x = index * slot + (slot - width) / 2;
      let y = H;
      const group = make("g", { class: "hx-day" });
      const parts = [];
      for (const provider of PROVIDERS) {
        const value = day.prompt[provider] || 0;
        if (!value) continue;
        const h = Math.max(1, (value / max) * H);
        y -= h;
        // A 2px gap of surface between stacked segments.
        group.append(make("rect", { x, y, width, height: Math.max(1, h - 2), rx: 2, class: `hx-p-${provider}` }));
        parts.push(`${PROVIDER_LABEL[provider]} ${tokens(value)}`);
      }
      const hit = make("rect", { x: index * slot, y: 0, width: slot, height: H, class: "hx-hit" });
      hit.dataset.tooltip = `${day.day} · ${tokens(total(day))} in ${day.turns} ${day.turns === 1 ? "turn" : "turns"}\n${parts.join(" · ")}\nCost: ${costText(day)}`;
      hit.setAttribute("aria-description", hit.dataset.tooltip);
      group.append(hit);
      svg.append(group);
      if (index === 0 || index === shown.length - 1 || (shown.length > 8 && index === shown.length >> 1)) {
        const label = make("text", { x: Math.min(W - 30, Math.max(30, x + width / 2)), y: H + 16, class: "hx-axis", "text-anchor": "middle" });
        label.textContent = day.day.slice(5);
        svg.append(label);
      }
    });
    const legend = el("div", "hx-legend");
    for (const provider of PROVIDERS) if (shown.some((day) => day.prompt[provider])) legend.append(providerChip(provider));
    wrap.append(legend, svg);
    return wrap;
  }

  function pickers() {
    const row = el("div", "hx-pickers");
    const repick = (patch) => {
      Object.assign(S.pick, patch);
      localStorage.setItem(LS.pick, JSON.stringify(S.pick));
      S.measure = null;
      void loadContext();
    };
    row.append(
      track(PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id] })), S.pick.provider, (provider) => repick({ provider }), "Provider"),
      track(Object.entries(MODE_LABEL).map(([id, label]) => ({ id, label })), S.pick.mode, (mode) => repick({ mode }), "Mode")
    );
    const select = el("select");
    select.setAttribute("aria-label", "Workspace");
    const folders = workspaceDirs();
    select.append(new Option("No workspace", ""));
    for (const folder of folders) select.append(new Option(folder, folder));
    select.value = S.pick.cwd || "";
    select.addEventListener("change", () => repick({ cwd: select.value || null }));
    row.append(themed(select));
    return row;
  }

  /** Recent folders are capped; saved threads and scope defaults keep older workspaces available. */
  function workspaceDirs() {
    const dirs = [
      S.pick.cwd,
      ...(S.config?.prefs?.recentWorkspaces || []),
      ...Object.values(S.config?.prefs?.scopeWorkspaces || {}),
      ...Object.values(S.mcp?.file?.workspaces || {}).map((layer) => layer.path),
      ...S.threads.map((thread) =>
        (thread.worktree && !thread.worktree.closed ? thread.worktree.home : null) ||
        thread.cwd || (thread.scope?.kind === "workspace" ? thread.scope.ref : null)
      ),
    ];
    const unique = new Map();
    for (const dir of dirs) if (dir && !unique.has(dirKey(dir))) unique.set(dirKey(dir), dir);
    return [...unique.values()];
  }

  function baselineFor(pick) {
    return S.stats?.baselines.find((b) => b.provider === pick.provider && b.mode === pick.mode) || null;
  }

  function renderContext() {
    const out = [pickers()];
    const ctx = S.context;
    if (!ctx) return [...out, empty(S.error || "Loading…")];
    const label = `${PROVIDER_LABEL[ctx.thread.provider]} ${MODE_LABEL[ctx.thread.mode]} thread`;
    const tools = ctx.scribeTools;
    const files = ctx.own.files.reduce((sum, file) => sum + file.tokens, 0);
    const scribe = ctx.instructions.tokens + tools.tokens;
    const base = baselineFor(ctx.thread);

    const summary = card(
      `What Scribe adds to a new ${label}`,
      "Estimated from the length of the text, so read these as rough sizes. Tool schemas count in full here; Claude Code lists MCP tools by name and loads a schema only when it is used, so there they cost less (Measure below gives its own count)."
    );
    summary.append(
      tiles([
        ["Scribe's instructions", `≈ ${tokens(ctx.instructions.tokens)}`, `${ctx.instructions.sections.length} parts${ctx.memories ? ` · ${ctx.memories} memories` : ""}`],
        ["Scribe's tools", tools.error ? "?" : `≈ ${tokens(tools.tokens)}`, tools.error ? "Could not list them" : `${tools.tools.length} tool schemas`],
        ["Instruction files", `≈ ${tokens(files)}`, ctx.own.files.length ? `${ctx.own.files.length} found, read by the provider` : "None found"],
        ["Measured first call", base ? tokens(base.median) : "–", base ? `Scribe's part is about ${pct(scribe, base.median)} of it` : "No first-prompt samples in range"],
      ])
    );
    if (base) {
      const rest = Math.max(0, base.median - scribe - files);
      summary.append(
        bars(
          [
            { label: "Scribe's instructions", value: ctx.instructions.tokens, text: `≈ ${tokens(ctx.instructions.tokens)}` },
            { label: "Scribe's tool schemas", value: tools.tokens, text: `≈ ${tokens(tools.tokens)}` },
            { label: "Instruction files", value: files, text: `≈ ${tokens(files)}`, tone: "quiet" },
            { label: "Everything else", sub: "the provider's prompt and tools, skills, other MCP servers, your message", value: rest, text: `≈ ${tokens(rest)}`, tone: "quiet" },
          ],
          { max: base.median }
        )
      );
    }
    out.push(summary);

    if (ctx.thread.provider === "claude") out.push(measureCard());

    const parts = card("Scribe's instructions, part by part", `${ctx.own.delivery} Open a part to read what is sent.`);
    parts.append(
      bars(
        [...ctx.instructions.sections]
          .sort((a, b) => b.tokens - a.tokens)
          .map((section) => ({ label: section.label, value: section.tokens, text: `≈ ${tokens(section.tokens)}`, detail: section.text }))
      )
    );
    out.push(parts);

    const toolCard = card("Scribe's tools", "The schema of each tool on Scribe's MCP server as this thread gets it, largest first, with how often threads called it in the chosen range.");
    if (tools.error) toolCard.append(empty(`Could not start Scribe's MCP server to list them: ${tools.error}`));
    else {
      const used = new Map((S.stats?.mcp || []).filter((row) => row.server === "scribe").map((row) => [row.tool, row.calls]));
      toolCard.append(
        bars(
          tools.tools.map((tool) => ({
            label: tool.name,
            sub: used.get(tool.name) ? `${count(used.get(tool.name))} calls` : "never called",
            value: tool.tokens,
            text: `≈ ${tokens(tool.tokens)}`,
            tone: used.get(tool.name) ? "" : "quiet",
            tip: tool.description,
          }))
        )
      );
    }
    out.push(toolCard);

    const own = card(`What ${PROVIDER_LABEL[ctx.thread.provider]} loads by itself`, `Not sent by Scribe, but part of every session.${ctx.own.files.length ? " Click an instruction file to edit it." : ""}`);
    const list = el("ul", "hx-list");
    for (const line of ctx.own.loads) list.append(el("li", null, line));
    own.append(list);
    if (ctx.own.files.length) {
      own.append(
        table(
          [
            { label: "Instruction file", get: (r) => el("code", null, r.path) },
            { label: "Tokens", num: true, get: (r) => `≈ ${tokens(r.tokens)}` },
          ],
          ctx.own.files,
          { onRow: (row) => void editFile({ title: row.path.split(/[\\/]/).pop(), path: row.path, onSaved: () => void loadContext() }) }
        )
      );
    }
    out.push(own);
    return out;
  }

  function measureCard() {
    const node = card(
      "Measured by Claude Code",
      "Starts Claude Code twice without sending a message, once set up as Scribe does and once as it runs on its own in the same folder, and asks each for its /context count. It calls no model; it takes a few seconds."
    );
    const m = S.measure;
    const run = button(m?.busy ? "Measuring…" : m?.scribe ? "Measure again" : "Measure", "hx-btn", async () => {
      S.measure = { busy: true };
      render();
      try {
        const payload = { provider: "claude", mode: S.pick.mode, cwd: S.pick.cwd };
        const [scribe, plain] = await Promise.all([api("POST", "/harness/measure", payload), api("POST", "/harness/measure", { ...payload, plain: true })]);
        S.measure = { scribe: scribe.measure, plain: plain.measure };
      } catch (err) {
        S.measure = { error: err.message };
      }
      render();
    });
    run.disabled = Boolean(m?.busy);
    node.append(run);
    if (m?.error) node.append(empty(`Could not measure: ${m.error}`));
    if (!m?.scribe) return node;
    const diff = m.scribe.totalTokens - m.plain.totalTokens;
    node.append(
      tiles([
        ["In Scribe", tokens(m.scribe.totalTokens), `${pct(m.scribe.totalTokens, m.scribe.maxTokens)} of the window`],
        ["Claude Code alone", tokens(m.plain.totalTokens), m.plain.model],
        ["Difference", `${diff >= 0 ? "+" : "−"}${tokens(Math.abs(diff))}`, "Per session, before your first message"],
      ])
    );
    const names = [...new Set([...m.scribe.categories, ...m.plain.categories].map((c) => c.name))];
    const find = (measure, name) => measure.categories.find((c) => c.name === name)?.tokens ?? 0;
    const rows = names.map((name) => ({ name, scribe: find(m.scribe, name), plain: find(m.plain, name) })).filter((row) => row.scribe || row.plain);
    node.append(
      table(
        [
          { label: "Category", get: (r) => r.name },
          { label: "In Scribe", num: true, get: (r) => tokens(r.scribe) },
          { label: "Claude Code alone", num: true, get: (r) => tokens(r.plain) },
          { label: "Difference", num: true, get: (r) => (r.scribe === r.plain ? "–" : `${r.scribe > r.plain ? "+" : "−"}${tokens(Math.abs(r.scribe - r.plain))}`) },
        ],
        rows
      )
    );
    const mcpTools = [...m.scribe.mcpTools].sort((a, b) => b.tokens - a.tokens).slice(0, 15);
    if (mcpTools.length) {
      const loaded = m.scribe.mcpTools.filter((tool) => tool.loaded).length;
      node.append(el("h4", null, `MCP tools in Scribe: ${m.scribe.mcpTools.length}, ${loaded} with their schema loaded at the start`));
      node.append(bars(mcpTools.map((tool) => ({ label: tool.name, sub: tool.loaded ? "" : "by name only", value: tool.tokens, text: tokens(tool.tokens), tone: tool.loaded ? "" : "quiet" }))));
    }
    if (m.scribe.skills.length) {
      node.append(el("h4", null, "Skill descriptions"));
      node.append(bars([...m.scribe.skills].sort((a, b) => b.tokens - a.tokens).map((skill) => ({ label: skill.name, sub: skill.source, value: skill.tokens, text: tokens(skill.tokens) }))));
    }
    return node;
  }

  function renderTools() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    if (!stats.totals.toolCalls) return [empty(`No tool calls in ${rangeText()}.`)];
    const out = [];
    const kinds = card("Calls by kind of tool");
    kinds.append(
      bars(
        stats.toolKinds.map((row) => ({
          label: KIND_LABEL[row.kind] || row.kind,
          sub: `${pct(row.errors, row.calls)} failed`,
          value: row.calls,
          text: count(row.calls),
        }))
      )
    );
    out.push(kinds);

    const fed = card(
      "What tool results put into the context",
      "The size of the results each kind of tool returned, as stored with the thread and estimated at four characters a token. Every later model call in the turn sends them again, so this is where a turn's cost grows."
    );
    fed.append(
      bars(
        [...stats.toolKinds]
          .sort((a, b) => b.outputTokens - a.outputTokens)
          .map((row) => ({ label: KIND_LABEL[row.kind] || row.kind, sub: `${tokens(row.outputTokens / Math.max(1, row.calls))} a call`, value: row.outputTokens, text: `≈ ${tokens(row.outputTokens)}` }))
      )
    );
    out.push(fed);

    const each = card("By tool and provider", "Each provider names its tools its own way. Commands that a provider names by their text are counted together.");
    each.append(
      table(
        [
          { label: "Tool", get: (r) => r.name },
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Calls", num: true, get: (r) => count(r.calls) },
          { label: "Failed", num: true, get: (r) => pct(r.errors, r.calls) },
          { label: "Result a call", num: true, get: (r) => `≈ ${tokens(r.outputTokens / Math.max(1, r.calls))}` },
          { label: "Results in all", num: true, get: (r) => `≈ ${tokens(r.outputTokens)}` },
          { label: "Time a call", num: true, get: (r) => duration(r.ms / Math.max(1, r.calls)) },
        ],
        stats.tools
      )
    );
    out.push(each);
    return out;
  }

  function renderMcp() {
    const out = [pickers()];
    const ctx = S.context;
    if (!ctx) return [...out, empty(S.error || "Loading…")];
    const calls = new Map();
    for (const row of S.stats?.mcp || []) {
      const entry = calls.get(row.server) || { calls: 0, errors: 0, tools: [] };
      entry.calls += row.calls;
      entry.errors += row.errors;
      entry.tools.push(row);
      calls.set(row.server, entry);
    }

    const servers = card(`Servers for a ${PROVIDER_LABEL[ctx.thread.provider]} ${MODE_LABEL[ctx.thread.mode]} thread${ctx.thread.cwd ? ` in ${ctx.thread.cwd}` : ""}`, ctx.own.mcpDelivery);
    const cwd = ctx.thread.cwd;
    const reload = (name) => {
      for (const key of [...S.probes.keys()]) if (!name || key.startsWith(`${name}\n`)) S.probes.delete(key);
      void loadContext();
    };
    const mcp = chat()?.mcp;
    const bar = el("div", "hx-actions");
    bar.append(button("Add server…", "hx-btn", () => mcp?.edit("global", null, () => reload())));
    if (cwd) bar.append(button("Add to this workspace…", "hx-btn", () => mcp?.edit(cwd, null, () => reload())));
    const importAll = button("Import…", "hx-btn", () => mcp?.importDialog(workspaceDirs(), () => reload()));
    importAll.dataset.tooltip = "From Claude Code, Cursor, Pi and Codex";
    const json = button("Edit JSON…", "hx-btn", () => mcp?.editJson("global", () => reload()));
    json.dataset.tooltip = "The servers that apply everywhere";
    bar.append(importAll, json);
    if (cwd) {
      const local = button("Workspace JSON…", "hx-btn", () => mcp?.editJson(cwd, () => reload()));
      local.dataset.tooltip = "This workspace's own servers and the ones it turns off";
      bar.append(local);
    }
    bar.append(button("Saved permissions…", "hx-btn", () => mcp?.permissions()));
    servers.append(bar);
    if (S.mcp?.error) servers.append(el("p", "ag-source-error", `${S.mcp.path} does not parse, so Scribe won't change it: ${S.mcp.error}`));
    const scribeUse = calls.get("scribe");
    const rows = [
      { name: "scribe", layer: "Built in", target: "Scribe's own page, browser, thread and memory tools", approve: "auto", active: true, builtin: true },
      ...ctx.servers,
    ];
    for (const server of rows) {
      const use = server.builtin ? scribeUse : calls.get(server.name.toLowerCase());
      const box = el("div", `hx-server${server.active ? "" : " off"}`);
      const head = el("div", "hx-server-head");
      const name = el("span", "hx-server-name");
      name.append(el("strong", null, server.name), el("span", `ag-tag${server.active ? " ok" : ""}`, server.active ? "Given to this thread" : server.why || "Not given"));
      head.append(name);
      const meta = [server.layer === "global" ? "Everywhere" : server.layer, server.builtin ? null : server.approve === "auto" ? "runs without asking" : "asks before each call", toolCount(server.tools, "allow", "allowed"), toolCount(server.tools, "disable", "disabled"), use ? `${count(use.calls)} calls, ${pct(use.errors, use.calls)} failed` : "no calls in range"].filter(Boolean).join(" · ");
      head.append(el("span", "hx-muted", meta));
      if (server.editable) {
        const controls = el("span", "hx-server-controls");
        const toggle = switchButton(server.enabled, `Use ${server.name}`, async () => {
          try {
            await api("PUT", "/mcp/enabled", { name: server.name, cwd, on: !server.enabled });
          } catch (err) {
            notice(err.message);
          }
          reload(server.name);
        });
        toggle.dataset.tooltip = !server.enabled ? "Turn on" : cwd && server.layer === "global" ? "Turn off in this workspace only" : server.layer === "global" ? "Turn off everywhere" : "Turn off";
        controls.append(toggle, button("Edit", "hx-btn", () => mcp?.edit(server.layer, server.name, () => reload(server.name))));
        head.append(controls);
      }
      box.append(head, el("code", "hx-target", server.target));
      const key = server.builtin ? "scribe" : `${server.name}\n${ctx.thread.cwd || ""}`;
      const probe = server.builtin ? ctx.scribeTools : S.probes.get(key);
      if (!server.builtin && !probe) {
        box.append(
          button("List its tools", "hx-btn", async (event) => {
            event.currentTarget.disabled = true;
            event.currentTarget.textContent = "Starting the server…";
            try {
              S.probes.set(key, await api("POST", "/harness/mcp/probe", { name: server.name, cwd: ctx.thread.cwd }));
            } catch (err) {
              S.probes.set(key, { tools: [], tokens: 0, error: err.message });
            }
            render();
          })
        );
      }
      if (probe?.error) box.append(empty(`Could not list its tools: ${probe.error}`));
      else if (probe) {
        const usedTools = new Map((use?.tools || []).map((row) => [row.tool, row.calls]));
        const details = el("details", "hx-server-tools");
        details.append(el("summary", null, `${probe.tools.length} tools · schemas ≈ ${tokens(probe.tokens)} tokens · ${probe.tools.filter((tool) => !usedTools.get(tool.name)).length} never called in range`));
        details.append(
          bars(
            probe.tools.map((tool) => ({
              label: tool.name,
              sub: usedTools.get(tool.name) ? `${count(usedTools.get(tool.name))} calls` : "never called",
              value: tool.tokens,
              text: `≈ ${tokens(tool.tokens)}`,
              tone: usedTools.get(tool.name) ? "" : "quiet",
              tip: tool.description,
            }))
          )
        );
        box.append(details);
      }
      servers.append(box);
    }
    if (S.mcp?.path) servers.append(el("p", "hx-hint hx-path", S.mcp.path));
    out.push(servers);

    const found = foundServers(cwd);
    if (found.length || S.mcpFoundError) {
      const box = card("Found in Claude Code", "Not in Scribe's list for Everywhere or this workspace. Import copies a server and leaves Claude Code's file unchanged. Imported servers ask before each call, including worker calls, unless the chat has full access; change this in the server's Edit dialog.");
      if (S.mcpFoundError) box.append(empty(`Could not check Claude Code's servers: ${S.mcpFoundError}`));
      for (const c of found) {
        const row = el("div", "hx-server");
        const head = el("div", "hx-server-head");
        const name = el("span", "hx-server-name");
        name.append(el("strong", null, c.name));
        head.append(name, el("span", "hx-muted", `${c.scope === "global" ? "Everywhere" : c.scope} · ${c.file}`));
        const take = button("Import", "hx-btn", async () => {
          take.disabled = true;
          try {
            await mcp.importOne(c);
            reload();
          } catch (err) {
            notice(err.message);
            take.disabled = false;
          }
        });
        take.setAttribute("aria-label", `Import ${c.name} from ${c.file}`);
        const controls = el("span", "hx-server-controls");
        controls.append(take);
        head.append(controls);
        row.append(head, el("code", "hx-target", c.server.url || [c.server.command, ...(c.server.args || [])].filter(Boolean).join(" ")));
        box.append(row);
      }
      out.push(box);
    }

    if (ctx.leftOut.length || ctx.duplicates.length) {
      const notes = card("Worth a look");
      const list = el("ul", "hx-list");
      if (ctx.leftOut.length) list.append(el("li", null, `In your own Claude Code config but not given to Claude threads here: ${ctx.leftOut.join(", ")}. A skill written for one of them finds its tools missing. Import them from Found in Claude Code or Import.`));
      if (ctx.duplicates.length) list.append(el("li", null, `Your Cursor config also loads Scribe as ${ctx.duplicates.join(", ")}, so a Cursor thread sees every page tool twice and pays for both sets of schemas. Remove it from ~/.cursor/mcp.json.`));
      notes.append(list);
      out.push(notes);
    }

    const all = card("Calls by server and tool", `Across every provider, in ${rangeText()}.`);
    all.append(
      S.stats?.mcp.length
        ? table(
            [
              { label: "Server", get: (r) => r.server },
              { label: "Tool", get: (r) => r.tool },
              { label: "Calls", num: true, get: (r) => count(r.calls) },
              { label: "Failed", num: true, get: (r) => pct(r.errors, r.calls) },
              { label: "Result a call", num: true, get: (r) => `≈ ${tokens(r.outputTokens / Math.max(1, r.calls))}` },
              {
                label: "Providers",
                get: (r) => {
                  const cell = el("span", "hx-chips");
                  for (const provider of PROVIDERS) if (r.providers.includes(provider)) cell.append(providerChip(provider));
                  return cell;
                },
              },
            ],
            S.stats.mcp
          )
        : empty("No MCP calls in this range.")
    );
    out.push(all);
    return out;
  }

  function renderSkills() {
    const out = [pickers()];
    if (!S.skills) return [...out, empty(S.error || "Loading…")];
    const uses = new Map((S.stats?.skills || []).map((row) => [row.name, row.calls]));
    const node = card(
      "Skills each provider finds",
      "Every chat is sent each skill's name and description; the body is read only when the skill is used. Uses are counted from Claude's Skill tool: the other providers read a skill as a plain file, which cannot be told apart from any other read. Click a skill to edit it, copy it to another provider, or remove it."
    );
    const add = button("New skill…", "hx-btn", () => newSkill());
    add.disabled = !S.skillFolders.length;
    node.append(add);
    const mine = S.skills.filter((skill) => skill.providers.includes(S.pick.provider) && (S.pick.mode !== "board" || (skill.scope === "user" && S.pick.provider === "claude")));
    node.append(
      tiles([
        [`For ${PROVIDER_LABEL[S.pick.provider]} ${MODE_LABEL[S.pick.mode]} threads`, count(mine.length), `≈ ${tokens(mine.reduce((sum, skill) => sum + skill.indexTokens, 0))} tokens of descriptions in every chat`],
        ["Found in all", count(S.skills.length), S.pick.cwd ? "Your own and this workspace's" : "Your own; pick a workspace for its skills"],
      ])
    );
    node.append(
      S.skills.length
        ? table(
            [
              { label: "Skill", get: (r) => el("strong", null, r.name) },
              {
                label: "Providers",
                get: (r) => {
                  const cell = el("span", "hx-chips");
                  for (const provider of PROVIDERS) if (r.providers.includes(provider)) cell.append(providerChip(provider));
                  return cell;
                },
              },
              { label: "From", get: (r) => (r.scope === "user" ? "You" : "Workspace") },
              { label: "In every chat", num: true, get: (r) => `≈ ${tokens(r.indexTokens)}` },
              { label: "When used", num: true, get: (r) => `≈ ${tokens(r.bodyTokens)}` },
              { label: "Files", num: true, get: (r) => count(r.files + 1) },
              { label: "Uses", num: true, get: (r) => (uses.has(r.name) ? count(uses.get(r.name)) : "–") },
              {
                label: "Description",
                get: (r) => {
                  const cell = el("span", "hx-desc", r.description || "No description");
                  cell.dataset.tooltip = r.file;
                  return cell;
                },
              },
            ],
            S.skills,
            { onRow: (row) => void openSkill(row) }
          )
        : empty("No skills found.")
    );
    out.push(node);
    const known = new Set(S.skills.map((skill) => skill.name));
    const other = (S.stats?.skills || []).filter((row) => !known.has(row.name));
    if (other.length) {
      const extra = card("Used, but not in these folders", "Skills Claude loaded from elsewhere: built into Claude Code, a plugin, or another workspace.");
      extra.append(bars(other.map((row) => ({ label: row.name, value: row.calls, text: count(row.calls) }))));
      out.push(extra);
    }
    return out;
  }

  /* ---------- editing: files, skills, memories ---------- */

  /** A text file in a dialog. extra(leave) gives buttons for the left of the action row. */
  async function editFile({ title, path, hint, onSaved, extra }) {
    let dirty = false;
    let leaving = false;
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const fail = (text) => {
      error.textContent = text;
      error.hidden = false;
    };
    // A click outside or Esc must not throw typed text away.
    const { panel, close } = chat().modal("hx-file", null, () => {
      if (!dirty || leaving) return true;
      fail("Save or cancel your changes first.");
      return false;
    });
    const leave = () => {
      leaving = true;
      close();
    };
    const heading = () => [el("h2", "ag-modal-title", title), el("p", "ag-modal-hint ag-mcp-path", path)];
    panel.append(...heading(), el("div", "ag-muted", "Loading…"));
    let file;
    try {
      file = await api("GET", `/harness/file?path=${encodeURIComponent(path)}${cwdQuery("&")}`);
    } catch (err) {
      const row = el("div", "ag-modal-actions");
      row.append(el("span", "ag-grow"), button("Close", "ag-btn", leave));
      panel.replaceChildren(...heading(), el("p", "ag-source-error", err.message), row);
      return;
    }
    const text = el("textarea", "ag-input ag-source-models hx-file-text");
    text.spellcheck = false;
    text.value = file.text;
    text.setAttribute("aria-label", title);
    text.addEventListener("input", () => {
      dirty = true;
    });
    const save = button("Save", "ag-btn primary", async () => {
      save.disabled = true;
      try {
        await api("PUT", "/harness/file", { path, cwd: S.pick.cwd, text: text.value });
        leave();
        onSaved?.();
      } catch (err) {
        fail(err.message);
        save.disabled = false;
      }
    });
    const row = el("div", "ag-modal-actions");
    row.append(...(extra?.(leave) ?? []), el("span", "ag-grow"), button("Cancel", "ag-btn", leave), save);
    panel.replaceChildren(...heading(), ...(hint ? [el("p", "ag-modal-hint", hint)] : []), text, error, row);
    setTimeout(() => text.focus(), 0);
  }

  function openSkill(skill) {
    return editFile({
      title: skill.name,
      path: skill.file,
      hint: "The name and description at the top go into every chat; the rest is read when the skill is used.",
      onSaved: () => void loadContext(),
      extra: (leave) => {
        const remove = button("Remove", "ag-btn ghost danger", async () => {
          const ok = await window.scribeApp?.confirm?.(`Remove ${skill.name}? Its folder is moved into Scribe's data folder, so it can be put back by hand.`, "Remove");
          if (!ok) return;
          try {
            const { kept } = await api("POST", "/harness/skills/remove", { file: skill.file, cwd: S.pick.cwd });
            leave();
            notice(kept ? `Removed ${skill.name}. Kept in ${kept}` : `Removed the link to ${skill.name}. The folder it pointed at is unchanged.`);
          } catch (err) {
            notice(err.message);
          }
          void loadContext();
        });
        const targets = S.skillFolders.filter((folder) => dirKey(folder.dir) !== dirKey(skill.folder));
        const copy = button("Copy to…", "ag-btn ghost", () => copySkill(skill, targets));
        copy.disabled = !targets.length;
        return [remove, copy];
      },
    });
  }

  /** Providers read different folders, so a skill reaches another one as a copy. */
  function copySkill(skill, targets) {
    const { panel, close } = chat().modal("ag-source");
    const select = folderSelect(targets, "Copy to");
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const run = button("Copy", "ag-btn primary", async () => {
      run.disabled = true;
      try {
        await api("POST", "/harness/skills/copy", { file: skill.file, folder: select.value, cwd: S.pick.cwd });
        close();
        notice(`Copied ${skill.name}.`);
        void loadContext();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        run.disabled = false;
      }
    });
    const row = el("div", "ag-modal-actions");
    row.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), run);
    panel.append(el("h2", "ag-modal-title", `Copy ${skill.name}`), field("To", select, "The whole skill folder is copied. Later edits to one copy do not reach the other."), error, row);
  }

  function newSkill() {
    const { panel, close } = chat().modal("ag-source");
    const name = el("input", "ag-input");
    name.placeholder = "e.g. release-notes";
    name.spellcheck = false;
    const description = el("textarea", "ag-input ag-mem-input");
    description.rows = 3;
    description.placeholder = "What it is for and when an agent should use it.";
    const select = folderSelect(S.skillFolders, "Where");
    const mine = S.skillFolders.find((folder) => folder.providers.includes(S.pick.provider));
    if (mine) {
      select.value = mine.dir;
      select.parentElement?.syncSelect?.();
    }
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const run = button("Create", "ag-btn primary", async () => {
      run.disabled = true;
      try {
        const { file } = await api("POST", "/harness/skills", { folder: select.value, name: name.value, description: description.value, cwd: S.pick.cwd });
        close();
        await loadContext();
        void openSkill(S.skills?.find((skill) => skill.file === file) || { name: name.value.trim(), file, folder: select.value });
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        run.disabled = false;
      }
    });
    const row = el("div", "ag-modal-actions");
    row.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), run);
    panel.append(
      el("h2", "ag-modal-title", "New skill"),
      field("Name", name),
      field("Description", description, "Sent to every chat of the provider, so keep it short."),
      field("For", select, S.pick.cwd ? null : "Pick a workspace on the page to add a skill to it."),
      error,
      row
    );
    setTimeout(() => name.focus(), 0);
  }

  /** public/memories.js draws the list and the popup that adds or edits one (#826), as in Agent settings. */
  function renderMemories() {
    const node = card("Shared memory");
    const ui = window.scribeMemories;
    node.append(
      ui
        ? ui.browser({ workspaces: () => S.config?.prefs?.recentWorkspaces || [], off: () => S.config?.prefs?.memory === false })
        : empty("Memories are not available here.")
    );
    return [node];
  }

  function renderThreads() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    const node = card("Threads that sent the most", `In ${rangeText()}. Open one to see where its turns went.`);
    node.append(
      stats.heavy.length
        ? table(
            [
              { label: "Thread", get: (r) => r.title },
              { label: "Provider", get: (r) => providerChip(r.provider) },
              { label: "Model", get: (r) => r.model },
              { label: "Turns", num: true, get: (r) => count(r.turns) },
              { label: "Tool calls", num: true, get: (r) => count(r.toolCalls) },
              { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
              { label: "Written", num: true, get: (r) => tokens(r.output) },
              { label: "Cost", num: true, get: (r) => costText(r) },
            ],
            stats.heavy,
            {
              onRow: (row) => {
                harness.close();
                window.scribeChat?.openThread?.(row.id);
              },
            }
          )
        : empty("No threads in this range.")
    );
    return [node];
  }

  /** "2 tools allowed" from a server's per-tool settings (#824), or null. */
  function toolCount(tools, policy, word) {
    const n = Object.values(tools || {}).filter((p) => p === policy).length;
    return n ? `${n} ${n === 1 ? "tool" : "tools"} ${word}` : null;
  }

  /** Claude Code servers for Everywhere or this workspace that Scribe's list does not have yet. */
  function foundServers(cwd) {
    const file = S.mcp?.file;
    if (!file) return [];
    const layer = (scope) => (scope === "global" ? file.mcpServers : Object.values(file.workspaces || {}).find((w) => dirKey(w.path) === dirKey(scope))?.mcpServers) || {};
    return S.mcpFound.filter((c) => (c.scope === "global" || (cwd && dirKey(c.scope) === dirKey(cwd))) && !Object.hasOwn(layer(c.scope), c.name));
  }

  /** agent.js draws the rules and their dialogs; the node is kept so each render does not fetch them again. */
  function renderHooks() {
    const hooks = chat()?.hooks;
    if (!hooks) return [empty("Hooks are not available here.")];
    if (!hooksNode) {
      hooksNode = card();
      hooks.mount(hooksNode);
    }
    return [hooksNode];
  }

  const RENDER = { overview: renderOverview, context: renderContext, tools: renderTools, mcp: renderMcp, skills: renderSkills, modes: renderModes, hooks: renderHooks, memories: renderMemories, threads: renderThreads };
  /** Sections whose numbers depend on the range. */
  const RANGED = new Set(["overview", "tools", "mcp", "threads", "context", "skills"]);

  /** The user's own modes: presets with a highest rung. The editor is the chat's (agent.js). */
  function renderModes() {
    const node = card(
      "Custom modes",
      "A mode of your own has a highest rung: it takes tools and MCP servers away from the agent, adds instructions, and sets the rung and web a thread starts with. It appears in the chat's access menu under the rungs, and board workers can use it. Editing a mode applies to the threads already in it."
    );
    const edit = (mode) => chat()?.editCustomMode(mode, render);
    node.append(button("New mode…", "hx-btn", () => edit(null)));
    const modes = chat()?.customModes() || [];
    if (!modes.length) node.append(empty("None yet."));
    else {
      node.append(
        table(
          [
            { label: "Mode", get: (r) => el("strong", null, r.name) },
            { label: "What it is", get: (r) => chat().customDetail(r, r.base) },
            { label: "MCP servers", get: (r) => (Array.isArray(r.mcp) ? r.mcp.join(", ") || "None" : r.mcp === "none" ? "None" : "All") },
            { label: "Instructions", get: (r) => (r.instructions.trim() ? `≈ ${tokens(Math.ceil(r.instructions.length / 4))} tokens` : "–") },
          ],
          modes,
          { onRow: edit }
        )
      );
    }
    return [node];
  }

  function render() {
    if (!root || root.hidden) return;
    const section = SECTIONS.find((s) => s.id === S.section) || SECTIONS[0];
    for (const control of nav.querySelectorAll("button")) control.setAttribute("aria-pressed", String(control.dataset.section === section.id));
    heading.textContent = section.label;
    controls.replaceChildren();
    if (RANGED.has(section.id)) {
      controls.append(
        track(RANGES, S.days, (days) => {
          S.days = days;
          localStorage.setItem(LS.days, String(days));
          render();
          void loadStats();
        }, "Range")
      );
    }
    controls.append(button("Refresh", "hx-btn", () => void refresh()));
    const close = button("", "settings-close", () => harness.close());
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.setAttribute("aria-label", "Close");
    close.dataset.tooltip = "Close (Esc)";
    controls.append(close);
    const scroll = body.scrollTop;
    // Keep the previous context visible while its replacement loads. Its actions must wait
    // for data matching the new provider/mode/workspace; the pickers remain usable.
    const thread = S.context?.thread;
    const contextPending = S.contextLoading || (thread && (thread.provider !== S.pick.provider || thread.mode !== S.pick.mode || thread.cwd !== S.pick.cwd));
    if (contextPending && renderedSection === section.id && body.firstElementChild?.classList.contains("hx-pickers")) {
      body.firstElementChild.replaceWith(pickers());
    } else {
      body.replaceChildren(...RENDER[section.id]());
    }
    renderedSection = section.id;
    if (contextPending && ["context", "mcp", "skills"].includes(section.id)) {
      for (const child of body.children) if (!child.classList.contains("hx-pickers")) child.inert = true;
    }
    if (S.error) body.prepend(empty(S.error));
    body.scrollTop = scroll;
    root.classList.toggle("loading", S.loading > 0);
  }

  async function load(fn) {
    S.loading += 1;
    S.error = "";
    try {
      await fn();
    } catch (err) {
      S.error = err.message;
    } finally {
      S.loading -= 1;
      render();
    }
  }

  let statsRequest = 0, contextRequest = 0;
  const loadStats = () => load(async () => {
    const request = ++statsRequest;
    const stats = await api("GET", `/harness/stats${S.days ? `?days=${S.days}` : ""}`);
    if (request === statsRequest) S.stats = stats;
  });

  const loadContext = () => load(async () => {
    const request = ++contextRequest;
    const pick = { ...S.pick };
    S.contextLoading = request;
    render();
    try {
      const [context, skills] = await Promise.all([
        api("POST", "/harness/context", { provider: pick.provider, mode: pick.mode, cwd: pick.cwd, scope: { kind: "global", ref: null } }),
        api("GET", `/harness/skills${pick.cwd ? `?cwd=${encodeURIComponent(pick.cwd)}` : ""}`),
      ]);
      if (request !== contextRequest) return;
      S.context = context;
      S.skills = skills.skills;
      S.skillFolders = skills.folders || [];
    } finally {
      if (S.contextLoading === request) S.contextLoading = 0;
    }
    void loadMcp(pick.cwd);
  });

  /** Scribe's MCP file and what Claude Code has that it does not, for the MCP section. Never holds up the rest. */
  let mcpRequest = 0;
  async function loadMcp(cwd) {
    const mcp = chat()?.mcp;
    if (!mcp) return;
    const request = ++mcpRequest;
    try {
      const [view, found] = await Promise.all([mcp.load(), mcp.findImports(cwd ? [cwd] : []).then((list) => ({ list }), (err) => ({ error: err.message }))]);
      if (request !== mcpRequest) return;
      S.mcp = view;
      S.mcpFound = (found.list || []).filter((c) => c.source === "claude");
      S.mcpFoundError = found.error || "";
    } catch (err) {
      if (request === mcpRequest) S.mcpFoundError = err.message;
    }
    if (S.section === "mcp") render();
  }

  async function refresh() {
    S.probes.clear();
    await Promise.all([
      loadStats(),
      load(async () => {
        const [config, result] = await Promise.all([api("GET", "/config"), api("GET", "/threads")]);
        S.config = config;
        S.threads = result.threads || [];
        if (S.pick.cwd === undefined) S.pick.cwd = null;
      }).then(loadContext),
    ]);
  }

  function mount() {
    root = el("div", "agent-harness");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Agent harness");
    const side = el("aside", "hx-side");
    side.append(el("h2", "hx-title", "Agent harness"));
    side.append(el("p", "hx-hint", "What your chats are given, what they do with it, and where you change it."));
    nav = el("nav", "hx-nav");
    nav.setAttribute("aria-label", "Harness sections");
    for (const section of SECTIONS) {
      const control = button(section.label, "hx-nav-link", () => {
        S.section = section.id;
        localStorage.setItem(LS.section, section.id);
        body.scrollTop = 0;
        render();
      });
      control.dataset.section = section.id;
      nav.append(control);
    }
    side.append(nav);
    // The providers' own allow, ask and deny rules: their dialog opens over this panel.
    const rules = button("Allowlists…", "hx-nav-link hx-nav-bottom", () => chat()?.openAllowlists?.());
    const settings = button("Agent settings…", "hx-nav-link", () => {
      harness.close();
      chat()?.openSettings?.();
    });
    side.append(rules, settings);
    const main = el("div", "hx-main");
    const head = el("header", "hx-head");
    heading = el("h2", "hx-heading");
    controls = el("div", "hx-controls");
    head.append(heading, controls);
    body = el("div", "hx-body");
    main.append(head, body);
    root.append(side, main);
    document.body.append(root);
    window.addEventListener(
      "keydown",
      (event) => {
        // Bubble phase, after the app's own Escape: a control or dialog over the panel that
        // handled the key has marked it.
        if (event.key !== "Escape" || event.defaultPrevented || !harness.isOpen()) return;
        if (document.querySelector("dialog[open]") || window.scribeSettingsUI?.isOpen?.() || document.querySelector(".ag-modal, .settings:not([hidden])")) return;
        event.preventDefault();
        event.stopPropagation();
        harness.close();
      }
    );
    // A tab picked from the strip shows that page again, as it does over the full-window chat.
    document.addEventListener(
      "click",
      (event) => {
        if (harness.isOpen() && event.target.closest?.(".tabs .tab, #new-tab") && !event.target.closest(".tab-close")) harness.close();
      },
      true
    );
  }

  let returnFocus = null;
  const harness = {
    isOpen: () => Boolean(root && !root.hidden),
    open(section) {
      if (!root) mount();
      if (section && RENDER[section]) S.section = section;
      returnFocus = document.activeElement;
      root.hidden = false;
      document.body.classList.add("agent-harness-open");
      render();
      void refresh();
      if (hooksNode) void chat()?.hooks?.render();
      nav.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    },
    close() {
      if (!harness.isOpen()) return false;
      root.hidden = true;
      document.body.classList.remove("agent-harness-open");
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      return true;
    },
    toggle() {
      if (harness.isOpen()) harness.close();
      else harness.open();
    },
  };
  window.scribeHarness = harness;
})();
