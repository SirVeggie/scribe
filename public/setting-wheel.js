/*
 * Setting wheel (#1017): while a cycling shortcut (Ctrl+' and friends) changes a composer setting, a
 * small drum over its pill shows the current value and two neighbours on each side. The current
 * value's text stays where the pill shows it; the neighbours unfold around it, shrinking and fading
 * toward the edges. It closes when Ctrl is released, and the text settles back into the pill.
 *
 * One fixed layer over the whole window, placed from the pill's position, so the floating chat, the
 * sidebar and the full window need no code of their own. The pill keeps its width while the drum is
 * open, so the bar doesn't shift behind it, and takes its new width once on close.
 */
(() => {
  const OPEN_MS = 230;
  const CLOSE_MS = 200;
  const STEP_MS = 190;
  const IDLE_MS = 900; // without Ctrl held (a menu, a script)
  const COPY = ["font", "letterSpacing", "color", "padding", "gap", "height", "display", "alignItems", "borderRadius"];
  const HOSTS = ".dock-panel, .agent-pane, .ag-full-main";

  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mod = (i, n) => ((i % n) + n) % n;
  const still = () => document.documentElement.classList.contains("fx-off") || matchMedia("(prefers-reduced-motion: reduce)").matches;

  let ctrlDown = false;
  let layer = null;
  let W = null; // the open wheel

  function ensureLayer() {
    if (layer?.isConnected) return layer;
    layer = document.createElement("div");
    layer.className = "ag-wheel-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
    return layer;
  }

  function rectOf(node) {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** The anchor the caller's finder returns now: the bar re-renders on every settings change. */
  function track() {
    const node = W.find();
    if (node !== W.el) {
      release(W.el);
      W.el = node && node.isConnected && node.getClientRects().length ? node : null;
    }
    if (W.el && !W.closing) {
      W.el.classList.add("ag-wheel-anchor");
      W.el.style.width = `${W.lockW}px`;
    }
    return W.el;
  }

  function release(node) {
    if (!node) return;
    node.classList.remove("ag-wheel-anchor");
    node.style.width = "";
  }

  function makeItem(item) {
    const node = document.createElement("span");
    const out = W.render(item) || {};
    node.className = `${W.baseCls} ${out.cls || ""} ag-wheel-item`;
    for (const p of COPY) node.style[p] = W.style[p];
    node.replaceChildren(...(out.nodes || []));
    return node;
  }

  function measure() {
    W.widths = W.items.map((item) => {
      const node = makeItem(item);
      node.style.visibility = "hidden";
      layer.append(node);
      const w = node.getBoundingClientRect().width;
      node.remove();
      return w;
    });
    for (const node of W.nodes.values()) node.remove();
    W.nodes.clear();
  }

  /** Row k steps from the current value, fully open: each a bit smaller and dimmer. */
  function offset(k) {
    const row = W.a.h + 2;
    const ak = Math.abs(k);
    return { y: row * (k - 0.045 * k * ak), scale: 1 - 0.09 * ak, op: Math.pow(Math.max(0, 1 - ak * 0.38), 1.2) };
  }

  /** The area the open drum needs, and the shift that keeps it inside its chat and the window. */
  function fit(base) {
    const n = W.items.length;
    const a = W.a;
    const pad = 8;
    const host = W.el?.closest(HOSTS);
    const hr = host ? host.getBoundingClientRect() : { left: 0, right: innerWidth };
    const bx = Math.max(0, hr.left), bw = Math.min(innerWidth, hr.right) - bx;
    const maxW = Math.max(...[-2, -1, 0, 1, 2].map((k) => W.widths[mod(base + k, n)]));
    const half = offset(2).y + a.h / 2 + 4;
    const box = { x: a.x - 6, y: a.y + a.h / 2 - half, w: maxW + 12, h: half * 2 };
    const dx = clamp(box.x, bx + pad, bx + bw - pad - box.w) - box.x;
    const dy = clamp(box.y, pad, innerHeight - pad - box.h) - box.y;
    return { box, dx, dy };
  }

  function frame(now) {
    if (!W) return;
    const el = track();
    if (!el && !W.closing) {
      finish();
      return;
    }
    const slow = still() ? 0 : 1;
    const tp = slow ? clamp((now - W.posT0) / STEP_MS, 0, 1) : 1;
    W.pos = lerp(W.posFrom, W.posTo, ease(tp));
    const to = slow ? clamp((now - W.openT0) / (W.closing ? CLOSE_MS : OPEN_MS), 0, 1) : 1;
    W.open = lerp(W.openFrom, W.openTo, ease(to));
    const settled = tp >= 1 && to >= 1;
    const px = (v) => (settled ? Math.round(v) : v); // whole pixels at rest keep the text sharp
    if (el) {
      const live = rectOf(el);
      // Closing: the text glides from where it was to the pill at its new width.
      W.a = W.closing ? { x: lerp(live.x, W.closeFrom.x, W.open), y: lerp(live.y, W.closeFrom.y, W.open), w: live.w, h: live.h } : live;
    }
    const a = W.a;
    const o = W.open;
    const n = W.items.length;
    const base = Math.round(W.pos);
    const f = fit(Math.round(W.posTo));
    const ox = f.dx * o, oy = f.dy * o;
    // A soft spot of the surface colour hides what is behind the values; it has no edge.
    const vw = f.box.w + 90, vh = f.box.h + 50;
    const vx = f.box.x + f.dx + f.box.w / 2 - vw / 2, vy = f.box.y + f.dy + f.box.h / 2 - vh / 2;
    Object.assign(W.veil.style, { width: `${vw}px`, height: `${vh}px`, transform: `translate(${vx}px, ${vy}px) scale(${lerp(0.4, 1, o)})`, opacity: String(o) });
    const keep = new Set();
    for (let i = base - 3; i <= base + 3; i++) {
      const k = i - W.pos;
      const p = offset(k);
      // Neighbours unfold from the current value; the outer ones a little later.
      const lag = 0.12 * Math.max(0, Math.abs(k) - 1);
      const ok = clamp((o - lag) / (1 - lag), 0, 1);
      const op = Math.abs(k) < 0.5 ? Math.max(p.op, 1 - o) : p.op * ok;
      if (op <= 0.01) continue;
      keep.add(i);
      let node = W.nodes.get(i);
      if (!node) {
        node = makeItem(W.items[mod(i, n)]);
        W.nodes.set(i, node);
        layer.append(node);
      }
      const sc = lerp(1, p.scale, ok);
      node.style.transform = `translate(${px(a.x + ox)}px, ${px(a.y + oy + p.y * ok)}px)${sc === 1 ? "" : ` scale(${sc})`}`;
      node.style.opacity = String(op);
    }
    for (const [i, node] of W.nodes) {
      if (keep.has(i)) continue;
      node.remove();
      W.nodes.delete(i);
    }
    if (W.closing && to >= 1) {
      finish();
      return;
    }
    if (settled && !W.closing && !W.holding && W.idle && now > W.idle) close();
    W.raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (!W) return;
    cancelAnimationFrame(W.raf);
    release(W.el);
    layer?.replaceChildren();
    W = null;
  }

  function close() {
    if (!W || W.closing) return;
    W.closing = true;
    W.closeFrom = { ...W.a };
    release(W.el); // the pill takes its new width once; the text glides to it
    W.openFrom = W.open;
    W.openTo = 0;
    W.openT0 = performance.now();
  }

  /** First opaque background from the anchor up: the drum fades into the surface it sits on. */
  function surface(node) {
    for (let el = node; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const alpha = /^rgba\(.*,\s*([\d.]+)\)$/.exec(bg)?.[1];
      if (bg.startsWith("rgb") && (alpha === undefined || Number(alpha) > 0.9)) return bg;
    }
    return "";
  }

  /**
   * Show one step of a cycling shortcut.
   * key: which setting in which chat; another key closes the open drum first.
   * find(): the pill now (the bar re-renders on each change).
   * items, from, to: the cycle's list, the index shown before this step and the new one.
   * render(item): { nodes, cls? }, the pill's content for that item.
   * Returns false when the pill isn't on screen, so the caller can fall back to a notice.
   */
  function show({ key, find, items, from, to, render }) {
    if (!items?.length) return false;
    if (W && (W.key !== key || W.closing)) finish();
    const now = performance.now();
    if (!W) {
      const el = find();
      if (!el?.isConnected || !el.getClientRects().length) return false;
      ensureLayer();
      const veil = document.createElement("div");
      veil.className = "ag-wheel-veil";
      const bg = surface(el);
      if (bg) veil.style.setProperty("--ag-wheel-surface", bg);
      layer.append(veil);
      const start = mod(from, items.length);
      W = {
        key, find, render, items, el: null, veil, nodes: new Map(),
        style: getComputedStyle(el), baseCls: el.className.replace(/\bap-[\w-]+\b/g, "").replace("ag-wheel-anchor", ""),
        lockW: el.getBoundingClientRect().width, a: rectOf(el),
        pos: start, posFrom: start, posTo: start, posT0: now,
        open: 0, openFrom: 0, openTo: 1, openT0: now, closing: false, idle: 0,
      };
      // Item styles copy the pill's; take them before it is hidden.
      W.style = Object.fromEntries(COPY.map((p) => [p, W.style[p]]));
      track();
      measure();
      W.raf = requestAnimationFrame(frame);
    } else if (items !== W.items) {
      W.items = items;
      W.render = render;
      measure();
    }
    // Step the shorter way round the loop to the new index.
    const n = items.length;
    let delta = mod(to - mod(Math.round(W.posTo), n), n);
    if (delta > n / 2) delta -= n;
    W.posFrom = W.pos;
    W.posTo = Math.round(W.posTo) + delta;
    W.posT0 = now;
    W.holding = ctrlDown;
    W.idle = now + IDLE_MS;
    return true;
  }

  const onKey = (event) => {
    ctrlDown = event.ctrlKey || event.metaKey;
    if (W && W.holding && !ctrlDown) {
      W.holding = false;
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", () => {
    ctrlDown = false;
    if (W) close();
  });

  window.scribeSettingWheel = { show, close };
})();
