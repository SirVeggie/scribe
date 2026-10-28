/* Agent chat: rendering helpers shared by the sidebar, floating, and full-window views. */
(() => {
  const ICONS = {
    chat: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3v-3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    mic: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    sparkle:
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.2l1.5 3.9 3.9 1.5-3.9 1.5L8 12l-1.5-3.9L2.6 6.6l3.9-1.5z" fill="currentColor"/><circle cx="12.8" cy="12.6" r="1.5" fill="currentColor"/></svg>',
    read: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 2h6.5L13 5.5V14H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 8h5M5.5 10.5h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    quote:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 9.5h3.5V13H3zM3 9.5C3 6.5 4 4.5 6.5 3.5M9.5 9.5H13V13H9.5zM9.5 9.5c0-3 1-5 3.5-6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10.8 2.4l2.8 2.8-7.9 7.9H2.9v-2.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.3 3.9l2.8 2.8" stroke="currentColor" stroke-width="1.3"/></svg>',
    execute:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6.2l2.2 1.8-2.2 1.8M8.4 10.2h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2l3.6 3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    fetch:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    // Limited web: the globe split along the bottom-left to top-right diagonal, lower half dim.
    fetchLimited:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><defs><clipPath id="ag-web-half-a"><path d="M0 0h15.1L0 15.1z"/></clipPath><clipPath id="ag-web-half-b"><path d="M16 .9V16H.9z"/></clipPath></defs><g clip-path="url(#ag-web-half-a)"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></g><g clip-path="url(#ag-web-half-b)" opacity=".4"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></g></svg>',
    mcp: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="5" height="4" rx="1" fill="currentColor"/><rect x="2" y="8.5" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="3" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    task: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="5" cy="5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="11" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 6.6l2.8 2.8" stroke="currentColor" stroke-width="1.3"/></svg>',
    think:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2.2a4.3 4.3 0 0 0-2.6 7.7c.5.4.8 1 .8 1.6v.7h3.6v-.7c0-.6.3-1.2.8-1.6A4.3 4.3 0 0 0 8 2.2z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.3 14h3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    todo: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 4.5l1.3 1.3 2.2-2.3M2.5 10.5l1.3 1.3 2.2-2.3M8 5h5.5M8 11h5.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    other:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="4" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12" cy="8" r="1.3" fill="currentColor"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.2 8.4l3 3 6.6-6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3.5M3.8 7.6L8 3.4l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    steer:
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.2 2.5v11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 8H6.2M8.7 5.3L6 8l2.7 2.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    expand:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    collapse:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5L14 2M6.5 9.5L2 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    popout:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M7 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9M9.5 2.5h4v4M13.5 2.5L8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    close:
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    diff: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.5 2v6M1.5 5h6M8.5 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.5 2.5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/></svg>',
    git: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.2v5.6M11.5 7.7c0 2.5-3 2.6-6.2 3.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    folder:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 3.5h4.2l1.5 1.5h7.3v8.5h-13z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    page: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 2h6.5L13 5.5V14H3z" fill="currentColor" opacity=".85"/></svg>',
    browser:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 5.8h12.4" stroke="currentColor" stroke-width="1.3"/><circle cx="3.9" cy="4.15" r=".6" fill="currentColor"/><circle cx="5.7" cy="4.15" r=".6" fill="currentColor"/></svg>',
    globe:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    box: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 4.5L8 2l6 2.5v7L8 14l-6-2.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2 4.5L8 7l6-2.5M8 7v7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    more: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
    image:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.6" r="1.2" fill="currentColor"/><path d="M2.5 12l3.8-3.6 2.6 2.4 2-1.8 2.6 2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    pen: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.7 2.4l2.9 2.9-7.9 7.9-3.5.6.6-3.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.1 4l2.9 2.9" stroke="currentColor" stroke-width="1.4"/></svg>',
    archive:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="2.6" width="12" height="3.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.3 5.8h9.4v6.4a1.3 1.3 0 0 1-1.3 1.3H4.6a1.3 1.3 0 0 1-1.3-1.3z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 9.2h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    trash:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 4.4h9M6.2 4.4V3.1h3.6v1.3M4.6 4.4l.7 8.4h5.4l.7-8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    revert:
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6.5h6.2a3.3 3.3 0 0 1 0 6.6H6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6 3.8L3.3 6.5 6 9.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    shield:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.8l5 2v4.1c0 3-2.2 5.3-5 6.3-2.8-1-5-3.3-5-6.3V3.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    question:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".8" fill="currentColor"/></svg>',
    gear: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M3.6 12.4l1.35-1.35M11.05 4.95l1.35-1.35" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    you: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5.5 3.5L10 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /*
   * An icon is one span whose ::before is painted through the icon's SVG as a CSS mask, in currentColor.
   * A long transcript shows thousands of icons: inline SVG cost 2-4 nodes and an HTML parse each (#362).
   * Each icon gets a class with its mask and size, at zero specificity so callers' CSS can resize it with
   * --agi-w / --agi-h.
   */
  let iconSheet = null;
  function iconClass(name) {
    const key = ICONS[name] ? name : "other";
    if (!iconSheet) {
      iconSheet = new CSSStyleSheet();
      iconSheet.insertRule(
        `.agi::before { content: ""; display: block; flex: none; width: var(--agi-w); height: var(--agi-h); background: currentColor;` +
          ` -webkit-mask: var(--agi) center / contain no-repeat; mask: var(--agi) center / contain no-repeat; forced-color-adjust: none; }`
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, iconSheet];
      iconSheet.done = new Set();
    }
    if (!iconSheet.done.has(key)) {
      iconSheet.done.add(key);
      const svg = ICONS[key].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
      const tag = svg.slice(0, svg.indexOf(">"));
      const w = /\swidth="([\d.]+)"/.exec(tag)?.[1] || 13;
      const h = /\sheight="([\d.]+)"/.exec(tag)?.[1] || w;
      iconSheet.insertRule(
        `:where(.agi-${key}) { --agi: url("data:image/svg+xml,${encodeURIComponent(svg)}"); --agi-w: ${w}px; --agi-h: ${h}px; }`,
        iconSheet.cssRules.length
      );
    }
    return `agi agi-${key}`;
  }

  function icon(name, cls = "ag-ico") {
    return el("span", `${cls} ${iconClass(name)}`);
  }

  function button(label, cls, onClick, title, tooltip = true) {
    const b = el("button", cls);
    b.type = "button";
    if (typeof label === "string") b.textContent = label;
    else if (label) b.append(label);
    if (title) {
      if (tooltip) b.dataset.tooltip = title;
      // Empty labels are often filled with visible text by the caller later.
      // Only name a supplied icon here; text buttons keep their content name.
      if (!tooltip || (label && typeof label !== "string" && !label.textContent.trim())) b.setAttribute("aria-label", title);
    }
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (diff < 45_000) return "now";
    const min = Math.round(diff / 60_000);
    if (min < 60) return `${min}m`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d`;
    return new Date(ms).toLocaleDateString();
  }

  /** Wall-clock when a turn or thread last finished. Today is just the time. */
  function finishTime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
    const date = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
    return `${date}, ${time}`;
  }

  function duration(ms) {
    if (!(ms >= 0)) return "";
    if (ms < 1000) return "<1s";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  function basename(p) {
    const parts = String(p || "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function dirname(p) {
    const parts = String(p || "").split(/[\\/]/);
    parts.pop();
    return parts.join("/");
  }

  function counts(added, removed) {
    const wrap = el("span", "ag-counts");
    if (added) wrap.append(el("span", "ag-add", `+${added}`));
    if (removed) wrap.append(el("span", "ag-del", `−${removed}`));
    if (!added && !removed) wrap.append(el("span", "ag-muted", "±0"));
    return wrap;
  }

  /* ---------- markdown ---------- */

  // The shared renderer (/vendor/scribe-md.js) reads the text, Scribe's page links included, as pages do;
  // the chat draws the blocks and adds its own links, code headers and table wrapping.
  const MD_OPTIONS = { html: true, image: (url) => url };

  function lexMarkdown(text) {
    try {
      return window.ScribeMd?.lex ? window.ScribeMd.lex(text, MD_OPTIONS) : null;
    } catch {
      return null;
    }
  }

  function plainMarkdown(target, text) {
    const box = el("div", "", String(text || ""));
    box.style.whiteSpace = "pre-wrap";
    target.replaceChildren(box);
  }

  function renderBlock(block) {
    try {
      return block.render();
    } catch {
      return el("p", "", block.raw);
    }
  }

  function renderMarkdown(target, text, ctx) {
    streams.delete(target);
    const blocks = lexMarkdown(text);
    if (!blocks) return plainMarkdown(target, text);
    target.replaceChildren(...blocks.map(renderBlock));
    enhanceMarkdown(target, ctx);
  }

  /** What renderMarkdownStream drew into a target: one entry per top-level block, { raw, nodes, open }. */
  const streams = new WeakMap();

  /**
   * renderMarkdown for text that keeps growing: closed blocks that did not change stay as they are, and only the
   * trailing block (the one still being written) is drawn again. Its code is highlighted once the fence closes.
   * Draw the final text with renderMarkdown: a later block can change an earlier one (a reference link's definition).
   */
  function renderMarkdownStream(target, text, ctx) {
    const tokens = lexMarkdown(text);
    if (!tokens) return renderMarkdown(target, text, ctx);
    let blocks = streams.get(target);
    if (!blocks) {
      target.replaceChildren();
      blocks = [];
    }
    let keep = 0;
    while (keep < blocks.length && keep < tokens.length - 1 && !blocks[keep].open && blocks[keep].raw === tokens[keep].raw) keep += 1;
    for (const block of blocks.slice(keep)) for (const node of block.nodes) node.remove();
    const next = blocks.slice(0, keep);
    for (let i = keep; i < tokens.length; i += 1) {
      const token = tokens[i];
      const open = i === tokens.length - 1;
      const box = document.createElement("div");
      box.append(renderBlock(token));
      enhanceMarkdown(box, ctx, { highlight: !open });
      const nodes = [...box.childNodes];
      target.append(...nodes);
      next.push({ raw: token.raw, nodes, open });
    }
    streams.set(target, next);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function enhanceMarkdown(root, ctx, opts = {}) {
    const autoLinks = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      const target = a.dataset.scribeOpen;
      if (target) {
        // A page or file link: [[key]], [label](scribe:key), [[peek:key]], a key written on its own.
        const mode = a.dataset.scribeMode;
        a.removeAttribute("href");
        a.removeAttribute("data-scribe-open");
        a.removeAttribute("data-scribe-mode");
        a.className = "ag-board-link";
        a.dataset.boardTarget = target;
        if (mode) a.dataset.boardMode = mode;
        a.tabIndex = 0;
        if (!a.textContent.trim()) {
          a.textContent = target;
          autoLinks.push(a);
        }
      } else if (/^https?:/i.test(href)) {
        a.removeAttribute("target");
        a.classList.add("ag-web-link");
        a.dataset.webHref = href;
      } else if (!href.startsWith("#") && !/^mailto:/i.test(href)) {
        // Relative and other links would navigate the board itself.
        a.removeAttribute("href");
        a.classList.add("ag-dead-link");
        a.dataset.tooltip = href;
      }
    }
    if (autoLinks.length && ctx?.resolvePages) {
      try {
        const pages = ctx.resolvePages(autoLinks.map((a) => a.dataset.boardTarget));
        for (const a of autoLinks) {
          const page = pages[a.dataset.boardTarget];
          if (page?.title) a.textContent = page.title;
          if (!page) a.classList.add("missing");
        }
      } catch {
        /* resolve is best effort */
      }
    }
    for (const pre of root.querySelectorAll("pre")) codeBlock(pre, opts.highlight !== false, ctx);
    for (const table of root.querySelectorAll("table")) {
      const wrap = el("div", "ag-table-wrap");
      table.replaceWith(wrap);
      wrap.append(table);
    }
  }

  /**
   * A fence's info string: a language (```ts), or Cursor's code reference (```12:40:src/app.ts), whose
   * language comes from the file's extension.
   */
  function fenceInfo(code) {
    const cls = [...(code?.classList || [])].find((c) => c.startsWith("language-"));
    const info = cls ? cls.slice(9) : "";
    const ref = /^\d+:\d+:(.+)$/.exec(info);
    if (ref) {
      const file = ref[1];
      const ext = /\.([\w+-]+)$/.exec(file)?.[1] || "";
      return { lang: ext.toLowerCase(), label: basename(file), title: file, ref: { file, line: Number(info.split(":")[0]) || 1 } };
    }
    return { lang: info.toLowerCase(), label: "", title: "", ref: null };
  }

  /** Fence tags highlight.js does not alias, mapped to a loaded grammar. */
  const FENCE_LANG = { psm1: "powershell", psd1: "powershell", vue: "xml", svelte: "xml", env: "ini" };

  function highlightLang(lang) {
    const hljs = window.hljs;
    if (!lang || !hljs) return "";
    if (hljs.getLanguage(lang)) return lang;
    const mapped = FENCE_LANG[lang];
    return mapped && hljs.getLanguage(mapped) ? mapped : "";
  }

  function codeBlock(pre, highlight = true, ctx) {
    const code = pre.querySelector("code");
    const { lang, label, title, ref } = fenceInfo(code);
    const hljs = window.hljs;
    const resolved = highlightLang(lang);
    const grammar = resolved && hljs?.getLanguage(resolved);
    const text = (code || pre).textContent.replace(/\n$/, "");
    if (highlight && grammar && code) {
      try {
        code.innerHTML = hljs.highlight(text, { language: resolved, ignoreIllegals: true }).value;
        code.classList.add("hljs");
      } catch {
        /* unhighlighted is fine */
      }
    }
    const block = el("div", "ag-code");
    const head = el("div", "ag-code-head");
    const name = el("span", "ag-code-lang", label || (resolved === lang && grammar?.name) || lang || "Text");
    if (title) name.dataset.tooltip = title;
    const copyLabel = el("span", "ag-copy-label", "Copy");
    const copy = button(icon("copy"), "ag-copy", () => {
      navigator.clipboard?.writeText(text).then(() => {
        copy.classList.add("done");
        copyLabel.textContent = "Copied";
        setTimeout(() => {
          copy.classList.remove("done");
          copyLabel.textContent = "Copy";
        }, 1200);
      });
    }, "Copy to clipboard");
    copy.append(copyLabel);
    head.append(name, copy);
    // A code reference offers to open its file in the IDE once the fence is closed.
    if (ref && highlight) ctx?.codeRef?.(head, ref);
    pre.replaceWith(block);
    block.append(head, pre);
  }

  /* ---------- diffs ---------- */

  /** Split a unified patch into files with hunks and numbered lines. */
  function parsePatch(patch) {
    const files = [];
    let file = null;
    let oldNo = 0;
    let newNo = 0;
    for (const line of String(patch || "").split("\n")) {
      if (line.startsWith("diff --git ")) {
        const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
        file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, lines: [], added: 0, removed: 0, binary: false, status: "M" };
        files.push(file);
        continue;
      }
      if (!file) continue;
      if (line.startsWith("new file")) file.status = "A";
      else if (line.startsWith("deleted file")) file.status = "D";
      else if (line.startsWith("rename from")) file.status = "R";
      else if (line.startsWith("Binary files")) file.binary = true;
      else if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("similarity") || line.startsWith("rename to") || line.startsWith("old mode") || line.startsWith("new mode")) continue;
      else if (line.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
        oldNo = m ? Number(m[1]) : 0;
        newNo = m ? Number(m[2]) : 0;
        file.lines.push({ kind: "hunk", text: line });
      } else if (line.startsWith("+")) {
        file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        file.added += 1;
      } else if (line.startsWith("-")) {
        file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newPosition: Math.max(1, newNo) });
        file.removed += 1;
      } else if (line.startsWith(" ")) {
        file.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      } else if (line.startsWith("\\")) {
        file.lines.push({ kind: "note", text: line });
      }
    }
    return files;
  }

  function renderDiffFile(file, { collapsedAfter = 600 } = {}) {
    const wrap = el("div", "ag-diff-file");
    const table = el("div", "ag-diff-lines");
    if (file.binary) {
      table.append(el("div", "ag-diff-note", "Binary file"));
    }
    const lines = file.lines;
    const renderRange = (from, to) => {
      const frag = document.createDocumentFragment();
      for (let i = from; i < to; i += 1) {
        const ln = lines[i];
        const row = el("div", `ag-dl ag-dl-${ln.kind}`);
        if (ln.kind === "hunk" || ln.kind === "note") {
          row.append(el("span", "ag-dl-no"), el("span", "ag-dl-no"), el("span", "ag-dl-text", ln.text));
        } else {
          if (ln.newNo || ln.newPosition) row.dataset.newLine = ln.newNo || ln.newPosition;
          row.append(
            el("span", "ag-dl-no", ln.oldNo ?? ""),
            el("span", "ag-dl-no", ln.newNo ?? ""),
            el("span", "ag-dl-text", (ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " ") + ln.text)
          );
        }
        frag.append(row);
      }
      return frag;
    };
    if (lines.length > collapsedAfter) {
      table.append(renderRange(0, collapsedAfter));
      const more = button(`Show ${lines.length - collapsedAfter} more lines`, "ag-diff-more", () => {
        more.replaceWith(renderRange(collapsedAfter, lines.length));
      });
      table.append(more);
    } else {
      table.append(renderRange(0, lines.length));
    }
    wrap.append(table);
    return wrap;
  }

  window.AgentRender = {
    ICONS,
    el,
    icon,
    button,
    timeAgo,
    finishTime,
    duration,
    basename,
    dirname,
    counts,
    renderMarkdown,
    renderMarkdownStream,
    escapeHtml,
    parsePatch,
    renderDiffFile,
  };
})();
