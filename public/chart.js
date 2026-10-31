/**
 * The chart component (<script src="/c/chart.js">): <s-chart> draws column, bar, line, area and
 * sparkline charts in Scribe's dark theme, following the dataviz rules: fixed categorical order,
 * thin marks with 4px rounded data ends, 2px lines, recessive hairline grid, one y-axis, a legend
 * from two series, hover tooltips, and a table view. See public/chart.md for the guide.
 */
(function () {
  if (customElements.get("s-chart")) return;
  // The dataviz reference palette's dark steps, in its fixed order; never cycled.
  const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const NS = "http://www.w3.org/2000/svg";
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  const style = document.createElement("style");
  style.textContent = `
:where(s-chart) { display: block; position: relative; margin: 0.8rem 0 1.2rem; font-size: 12px; color: var(--muted); }
:where(s-chart[type="spark"]) { display: inline-block; margin: 0; vertical-align: middle; }
:where(s-chart) :where(.chart-head) { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-height: 22px; margin-bottom: 6px; }
:where(s-chart) :where(.chart-title) { color: var(--text); font-weight: 600; font-size: 13px; margin-right: auto; }
:where(s-chart) :where(.chart-legend) { display: flex; gap: 12px; flex-wrap: wrap; }
:where(s-chart) :where(.chart-key) { display: inline-flex; align-items: center; gap: 6px; }
:where(s-chart) :where(.chart-key i) { width: 10px; height: 10px; border-radius: 3px; }
:where(s-chart) :where(.chart-key.line i) { height: 2px; border-radius: 1px; }
:where(s-chart) :where(.chart-toggle) { min-height: 22px; padding: 0 8px; font-size: 11.5px; }
:where(s-chart) :where(svg) { display: block; overflow: visible; }
:where(s-chart) :where(svg text) { fill: var(--muted); font: inherit; font-size: 11px; }
:where(s-chart) :where(svg text.value) { fill: var(--text); }
:where(s-chart) :where(.chart-tip) { position: absolute; z-index: 5; pointer-events: none; padding: 6px 9px; border-radius: 7px;
  background: var(--kit-surface, #202024); box-shadow: 0 0 0 1px var(--border), 0 6px 20px rgba(0, 0, 0, 0.45);
  color: var(--text); white-space: nowrap; font-size: 12px; line-height: 1.5; }
:where(s-chart) :where(.chart-tip b) { display: block; font-weight: 600; }
:where(s-chart) :where(.chart-tip span) { display: flex; align-items: center; gap: 6px; }
:where(s-chart) :where(.chart-tip i) { width: 8px; height: 8px; border-radius: 2px; }
:where(s-chart) :where(.chart-tip em) { font-style: normal; margin-left: auto; padding-left: 12px; font-variant-numeric: tabular-nums; }
:where(s-chart) :where(table) { margin: 0; font-size: 12px; color: var(--text); }
:where(s-chart) :where(td.num) { text-align: right; font-variant-numeric: tabular-nums; }
`;
  document.head.appendChild(style);

  const el = (tag, attrs, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    parent?.appendChild(node);
    return node;
  };
  const html = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    parent?.appendChild(node);
    return node;
  };

  /** Round ticks from 0 (or the minimum, when below 0) past the maximum. */
  function ticks(min, max, count) {
    if (min === max) max = min + 1;
    const raw = (max - min) / count;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.floor(min / step) * step; v < max + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
    return out;
  }

  /** A bar with a 4px rounded data end and a square end at the baseline. */
  function barPath(x, y, w, h, dir) {
    const r = Math.min(4, w / 2, Math.abs(h));
    if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    if (dir === "down") return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
    if (dir === "right") return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
  }

  class Chart extends HTMLElement {
    static observedAttributes = ["type", "data", "x", "y", "names", "unit", "label", "height", "colors"];
    connectedCallback() {
      if (!this.observer) {
        this.observer = new ResizeObserver(() => { if (this.offsetWidth !== this.lastWidth) this.render(); });
      }
      this.observer.observe(this);
      queueMicrotask(() => this.render());
    }
    disconnectedCallback() { this.observer?.disconnect(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    get data() {
      if (this.rows) return this.rows;
      const source = this.getAttribute("data") ?? this.querySelector('script[type="application/json"]')?.textContent;
      if (!source) return [];
      try { return JSON.parse(source); } catch (error) { console.warn("[s-chart] data is not valid JSON:", error.message); return []; }
    }
    set data(rows) { this.rows = Array.isArray(rows) ? rows : []; if (this.isConnected) this.render(); }

    spec() {
      const rows = this.data.filter((row) => row && typeof row === "object");
      const keys = rows.length ? Object.keys(rows[0]) : [];
      const xKey = this.getAttribute("x") || keys.find((k) => typeof rows[0][k] !== "number") || keys[0];
      let yKeys = (this.getAttribute("y") || "").split(",").map((k) => k.trim()).filter(Boolean);
      if (!yKeys.length) yKeys = keys.filter((k) => k !== xKey && rows.some((row) => typeof row[k] === "number"));
      if (yKeys.length > SERIES.length) {
        console.warn(`[s-chart] ${yKeys.length} series; only the first ${SERIES.length} are drawn. Fold the rest into "Other" or use small multiples.`);
        yKeys = yKeys.slice(0, SERIES.length);
      }
      const names = (this.getAttribute("names") || "").split(",").map((n) => n.trim());
      const colors = (this.getAttribute("colors") || "").split(",").map((c) => c.trim());
      const series = yKeys.map((key, i) => ({ key, name: names[i] || key, color: colors[i] || SERIES[i] }));
      const type = this.getAttribute("type") || "column";
      return { rows, xKey, series, type, unit: this.getAttribute("unit") || "" };
    }

    format(value, full) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "–";
      return (full ? exact : compact).format(value) + this.spec().unit;
    }

    render() {
      const spec = this.spec();
      this.lastWidth = this.offsetWidth;
      this.replaceChildren(...[...this.querySelectorAll(':scope > script[type="application/json"]')]);
      const label = this.getAttribute("label");
      if (spec.type === "spark") return this.spark(spec, label);
      const head = html("div", "chart-head", this);
      if (label) html("div", "chart-title", head, label);
      if (spec.series.length > 1) {
        const legend = html("div", "chart-legend", head);
        for (const s of spec.series) {
          const key = html("span", "chart-key" + (spec.type === "line" ? " line" : ""), legend);
          html("i", "", key).style.background = s.color;
          key.append(s.name);
        }
      }
      const toggle = html("button", "chart-toggle", head, this.showTable ? "Chart" : "Table");
      toggle.type = "button";
      toggle.addEventListener("click", () => { this.showTable = !this.showTable; this.render(); });
      if (!label && spec.series.length < 2) head.style.justifyContent = "flex-end";
      if (this.showTable) return this.table(spec);
      if (!spec.rows.length || !spec.series.length) { html("div", "", this, "No data"); return; }
      const tip = html("div", "chart-tip", this);
      tip.hidden = true;
      this.tip = tip;
      if (spec.type === "bar") this.bars(spec);
      else this.plot(spec);
      const svg = this.querySelector("svg");
      svg?.setAttribute("role", "img");
      svg?.setAttribute("aria-label", label || spec.series.map((s) => s.name).join(", "));
    }

    table(spec) {
      const table = html("table", "", this);
      const head = html("tr", "", html("thead", "", table));
      html("th", "", head, spec.xKey);
      for (const s of spec.series) html("th", "", head, s.name);
      const body = html("tbody", "", table);
      for (const row of spec.rows) {
        const tr = html("tr", "", body);
        html("td", "", tr, String(row[spec.xKey] ?? ""));
        for (const s of spec.series) html("td", "num", tr, this.format(row[s.key], true));
      }
    }

    showTip(x, y, title, entries) {
      const tip = this.tip;
      tip.replaceChildren();
      html("b", "", tip, title);
      for (const { name, color, value } of entries) {
        const line = html("span", "", tip);
        html("i", "", line).style.background = color;
        line.append(name);
        html("em", "", line, this.format(value, true));
      }
      tip.hidden = false;
      const left = Math.min(Math.max(0, x + 12), this.clientWidth - tip.offsetWidth);
      tip.style.left = left + "px";
      tip.style.top = Math.max(0, y - tip.offsetHeight - 8) + "px";
    }
    hideTip() { if (this.tip) this.tip.hidden = true; }

    /** Columns, lines and areas: categories along x, one y-axis. */
    plot(spec) {
      const width = Math.max(200, this.clientWidth);
      const height = Number(this.getAttribute("height")) || 220;
      const values = spec.rows.flatMap((row) => spec.series.map((s) => row[s.key])).filter((v) => typeof v === "number");
      const scaleTicks = ticks(Math.min(0, ...values), Math.max(0, ...values), 4);
      const lo = scaleTicks[0], hi = scaleTicks[scaleTicks.length - 1];
      const axisW = Math.max(...scaleTicks.map((t) => this.format(t).length)) * 6.5 + 10;
      const lineish = spec.type === "line" || spec.type === "area";
      const endLabels = lineish && spec.series.length <= 4;
      const left = axisW, right = endLabels ? 44 : 8, top = 8, bottom = 22;
      const plotW = width - left - right, plotH = height - top - bottom;
      const y = (v) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
      const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}` }, this);
      for (const t of scaleTicks) {
        el("line", { x1: left, x2: width - right, y1: y(t), y2: y(t), stroke: "var(--border)", "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
        el("text", { x: left - 8, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = this.format(t);
      }
      const n = spec.rows.length;
      const band = plotW / n;
      const cx = (i) => left + (lineish ? (n === 1 ? plotW / 2 : (i * plotW) / (n - 1)) : band * i + band / 2);
      // Thin out x labels so they never collide: roughly one per 70px.
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 70))));
      spec.rows.forEach((row, i) => {
        if (i % every && i !== n - 1) return;
        const anchor = lineish && i === 0 ? "start" : lineish && i === n - 1 ? "end" : "middle";
        el("text", { x: cx(i), y: height - 6, "text-anchor": anchor }, svg).textContent = String(row[spec.xKey] ?? "");
      });
      const marks = el("g", {}, svg);
      if (!lineish) {
        const k = spec.series.length;
        const barW = Math.max(2, Math.min(24, (band * 0.72 - 2 * (k - 1)) / k));
        const groupW = barW * k + 2 * (k - 1);
        spec.rows.forEach((row, i) => {
          spec.series.forEach((s, j) => {
            const v = row[s.key];
            if (typeof v !== "number") return;
            const x0 = cx(i) - groupW / 2 + j * (barW + 2);
            const y0 = y(Math.max(0, v)), h = Math.abs(y(v) - y(0));
            el("path", { d: barPath(x0, y0, barW, Math.max(h, 0.5), v < 0 ? "down" : "up"), fill: s.color }, marks);
          });
        });
      } else {
        spec.series.forEach((s) => {
          const points = spec.rows.map((row, i) => [cx(i), row[s.key]]).filter((p) => typeof p[1] === "number");
          if (!points.length) return;
          const d = points.map(([px, v], i) => `${i ? "L" : "M"}${px},${y(v)}`).join("");
          if (spec.type === "area") el("path", { d: `${d}L${points[points.length - 1][0]},${y(Math.max(lo, 0))}L${points[0][0]},${y(Math.max(lo, 0))}Z`, fill: s.color, "fill-opacity": 0.1 }, marks);
          el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, marks);
          const [ex, ev] = points[points.length - 1];
          el("circle", { cx: ex, cy: y(ev), r: 4, fill: s.color, stroke: "var(--bg)", "stroke-width": 2 }, marks);
          if (endLabels) el("text", { x: ex + 8, y: y(ev) + 4, class: "value" }, svg).textContent = this.format(ev);
        });
      }
      // Hover: the nearest category; a crosshair on lines, the column group's band on columns.
      const cross = el("line", { y1: top, y2: top + plotH, stroke: "var(--muted)", "stroke-width": 1, opacity: 0 }, svg);
      const hit = el("rect", { x: left, y: top, width: plotW, height: plotH, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", (event) => {
        const box = svg.getBoundingClientRect();
        const px = event.clientX - box.left;
        const i = lineish ? Math.round(n === 1 ? 0 : ((px - left) / plotW) * (n - 1)) : Math.floor((px - left) / band);
        const row = spec.rows[Math.max(0, Math.min(n - 1, i))];
        const at = cx(Math.max(0, Math.min(n - 1, i)));
        if (lineish) { cross.setAttribute("x1", at); cross.setAttribute("x2", at); cross.setAttribute("opacity", 0.5); }
        const tipY = Math.min(...spec.series.map((s) => (typeof row[s.key] === "number" ? y(row[s.key]) : top + plotH)));
        this.showTip(at + (svg.getBoundingClientRect().left - this.getBoundingClientRect().left), tipY + svg.offsetTop,
          String(row[spec.xKey] ?? ""), spec.series.map((s) => ({ name: s.name, color: s.color, value: row[s.key] })));
      });
      hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); this.hideTip(); });
    }

    /** Horizontal bars: one row per category, values at the tips. */
    bars(spec) {
      const width = Math.max(200, this.clientWidth);
      const k = spec.series.length;
      const barH = k > 1 ? 14 : 20, rowH = barH * k + 2 * (k - 1) + 12;
      const labelW = Math.min(width * 0.35, Math.max(...spec.rows.map((row) => String(row[spec.xKey] ?? "").length)) * 6.5 + 12);
      const values = spec.rows.flatMap((row) => spec.series.map((s) => row[s.key])).filter((v) => typeof v === "number");
      const max = Math.max(0, ...values), min = Math.min(0, ...values);
      const plotW = width - labelW - 48;
      const x = (v) => labelW + ((v - min) / (max - min || 1)) * plotW;
      const height = spec.rows.length * rowH;
      const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}` }, this);
      el("line", { x1: x(0), x2: x(0), y1: 0, y2: height, stroke: "var(--border)", "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
      spec.rows.forEach((row, i) => {
        const top = i * rowH + 6;
        el("text", { x: labelW - 10, y: top + (rowH - 12) / 2 + 4, "text-anchor": "end" }, svg).textContent = String(row[spec.xKey] ?? "");
        spec.series.forEach((s, j) => {
          const v = row[s.key];
          if (typeof v !== "number") return;
          const y0 = top + j * (barH + 2);
          const x0 = x(Math.min(0, v)), w = Math.max(Math.abs(x(v) - x(0)), 0.5);
          el("path", { d: barPath(x0, y0, w, barH, v < 0 ? "left" : "right"), fill: s.color }, svg);
          if (k === 1) el("text", { x: v < 0 ? x0 - 6 : x0 + w + 6, y: y0 + barH / 2 + 4, "text-anchor": v < 0 ? "end" : "start", class: "value" }, svg).textContent = this.format(v);
        });
        const hit = el("rect", { x: 0, y: i * rowH, width, height: rowH, fill: "transparent" }, svg);
        hit.addEventListener("pointermove", () => this.showTip(x(Math.max(0, ...spec.series.map((s) => row[s.key] || 0))), i * rowH + svg.offsetTop + 6,
          String(row[spec.xKey] ?? ""), spec.series.map((s) => ({ name: s.name, color: s.color, value: row[s.key] }))));
        hit.addEventListener("pointerleave", () => this.hideTip());
      });
    }

    /** A sparkline: one series, no axes, the last value marked. */
    spark(spec, label) {
      const s = spec.series[0];
      const width = Number(this.getAttribute("width")) || 120, height = Number(this.getAttribute("height")) || 28;
      const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img" }, this);
      const values = s ? spec.rows.map((row) => row[s.key]).filter((v) => typeof v === "number") : [];
      if (values.length < 2) return;
      svg.setAttribute("aria-label", `${label || s.name}: ${values.map((v) => this.format(v, true)).join(", ")}`);
      const lo = Math.min(...values), hi = Math.max(...values);
      const px = (i) => 3 + (i * (width - 10)) / (values.length - 1);
      const py = (v) => height - 5 - ((v - lo) / (hi - lo || 1)) * (height - 10);
      el("path", { d: values.map((v, i) => `${i ? "L" : "M"}${px(i)},${py(v)}`).join(""), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const last = values.length - 1;
      el("circle", { cx: px(last), cy: py(values[last]), r: 3, fill: s.color, stroke: "var(--bg)", "stroke-width": 2 }, svg);
    }
  }
  customElements.define("s-chart", Chart);
})();
