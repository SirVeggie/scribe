/* Floating shell scrollbars. Wheel, touch, keyboard and scroll anchoring remain native. */
(() => {
  const AXES = ['vertical', 'horizontal'];
  const surfaces = new Map();
  const dirty = new Set([document.body]);
  const changedElements = new Set();
  // A full pass measures and hit-tests every surface. Scrolling a surface or changing the text
  // inside it only moves or resizes that surface's thumbs from the cached bar geometry.
  const touched = new Set();
  let full = true, frame = 0, pointer = null, dragging = null, fadeTimer, settleTimer = 0;
  const scrollable = value => /^(auto|scroll)$/.test(value);
  const isOverlay = node => node instanceof Element && Boolean(node.closest('.overlay-scrollbar'));
  const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
  const queueFull = () => { full = true; queue(); };
  const resize = new ResizeObserver(queueFull);

  function register(el) {
    if (surfaces.has(el) || isOverlay(el) || !(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    // Respect controls intentionally hiding their scrollbar (e.g. the tab strip).
    if (style.scrollbarWidth === 'none' || (!scrollable(style.overflowX) && !scrollable(style.overflowY))) return false;
    el.classList.add('overlay-scroll-surface');
    surfaces.set(el, { bars: {}, axes: {}, until: 0, visible: false, nested: false });
    resize.observe(el);
    return true;
  }

  function makeBar(el, state, axis) {
    const bar = document.createElement('div');
    bar.className = `overlay-scrollbar ${axis}`;
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'overlay-scrollbar-thumb';
    bar.append(thumb);
    document.body.append(bar);
    const data = { bar, thumb, axis, barCss: '', thumbCss: '' };
    state.bars[axis] = data;
    thumb.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      dragging = { el, data, start: axis === 'vertical' ? event.clientY : event.clientX,
        scroll: axis === 'vertical' ? el.scrollTop : el.scrollLeft };
      queue();
    });
    thumb.addEventListener('pointermove', event => {
      if (dragging?.data !== data) return;
      const m = state.axes[axis];
      const delta = (axis === 'vertical' ? event.clientY : event.clientX) - dragging.start;
      const value = dragging.scroll + delta * m.range / Math.max(1, m.travel);
      if (axis === 'vertical') el.scrollTop = value;
      else el.scrollLeft = value;
    });
    const release = () => {
      if (dragging?.data !== data) return;
      dragging = null;
      state.until = performance.now() + 900;
      queue();
    };
    thumb.addEventListener('lostpointercapture', release);
    thumb.addEventListener('pointerup', release);
    thumb.addEventListener('pointercancel', release);
    bar.addEventListener('wheel', event => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit, behavior: 'instant' });
      event.preventDefault();
    }, { passive: false });
    return data;
  }

  const sizes = (el, axis) => axis === 'vertical' ? [el.clientHeight, el.scrollHeight] : [el.clientWidth, el.scrollWidth];
  const scrollOf = (el, axis) => axis === 'vertical' ? el.scrollTop : el.scrollLeft;

  function sizeThumb(m, size, total) {
    m.size = size;
    m.total = total;
    m.needed = m.scrollable && total > size + 1 && size > 0;
    if (!m.needed) return;
    m.thumbSize = Math.min(m.length, Math.max(28, m.length * size / total));
    m.range = total - size;
    m.travel = m.length - m.thumbSize;
  }

  // Reads only: layout stays clean until every surface is measured and hit-tested.
  function measure(el, state) {
    const rect = el.getBoundingClientRect();
    state.visible = Boolean(rect.width && rect.height) && !el.closest('[inert]');
    if (!state.visible) return false;
    const style = getComputedStyle(el);
    const clip = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
      right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) };
    let moving = false;
    // Fixed handles follow the panel's finite entrance/size animations too.
    for (let node = el; node; node = node.parentElement) {
      if (node.getAnimations().some(animation => animation.playState === 'running' &&
        animation.effect?.getTiming().iterations !== Infinity)) moving = true;
    }
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const ps = getComputedStyle(parent);
      if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
      const bounds = parent.getBoundingClientRect();
      if (ps.overflowX !== 'visible') { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
      if (ps.overflowY !== 'visible') { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
    }
    state.rtl = style.direction === 'rtl';
    const sx = rect.width / el.offsetWidth, sy = rect.height / el.offsetHeight;
    const left = rect.left + el.clientLeft * sx;
    const top = rect.top + el.clientTop * sy;
    const width = el.clientWidth * sx, height = el.clientHeight * sy;
    for (const axis of AXES) {
      const vertical = axis === 'vertical';
      const length = Math.max(0, (vertical ? height : width) - 4);
      const x = vertical ? left + width - 12 : left + 2;
      const y = vertical ? top + 2 : top + height - 12;
      const m = { scrollable: scrollable(vertical ? style.overflowY : style.overflowX), clip, left, top, width, height,
        length, x, y, w: vertical ? 12 : length, h: vertical ? length : 12, scroll: scrollOf(el, axis) };
      const [size, total] = sizes(el, axis);
      sizeThumb(m, size, total);
      state.axes[axis] = m;
    }
    return moving;
  }

  function hitTest(el, state) {
    for (const axis of AXES) {
      const m = state.axes[axis];
      if (!state.visible || !m.needed) continue;
      const { clip, x, y, w, h } = m;
      // Do not float a covered surface's handle over a dialog or menu above it.
      const cx = Math.max(clip.left, Math.min(clip.right - 1, x + w / 2));
      const cy = Math.max(clip.top, Math.min(clip.bottom - 1, y + h / 2));
      const hit = document.elementsFromPoint(cx, cy).find(node => !isOverlay(node));
      m.covered = !hit || !el.contains(hit) || clip.right <= clip.left || clip.bottom <= clip.top;
    }
  }

  const setHidden = (data, hidden) => { if (data.bar.hidden !== hidden) data.bar.hidden = hidden; };

  function writeThumb(state, data, m) {
    // Chromium uses negative scrollLeft for RTL surfaces.
    const fraction = data.axis === 'vertical' || !state.rtl ? m.scroll / m.range : 1 + m.scroll / m.range;
    const offset = Math.max(0, Math.min(1, fraction)) * m.travel;
    const css = data.axis === 'vertical' ? `top:${offset}px;height:${m.thumbSize}px` : `left:${offset}px;width:${m.thumbSize}px`;
    if (css !== data.thumbCss) data.thumb.style.cssText = data.thumbCss = css;
  }

  function write(el, state) {
    for (const axis of AXES) {
      const m = state.axes[axis];
      let data = state.bars[axis];
      if (!state.visible || !m?.needed) { if (data) setHidden(data, true); continue; }
      data ||= makeBar(el, state, axis);
      const { clip, x, y, w, h } = m;
      const css = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;clip-path:inset(${Math.max(0, clip.top - y)}px ${Math.max(0, x + w - clip.right)}px ${Math.max(0, y + h - clip.bottom)}px ${Math.max(0, clip.left - x)}px)`;
      if (css !== data.barCss) data.bar.style.cssText = data.barCss = css;
      writeThumb(state, data, m);
      setHidden(data, m.covered);
    }
  }

  // Scroll offset and content size of a surface whose bars have not moved. False when that is not enough.
  function remeasure(el, state) {
    if (!el.isConnected || state.nested) return false;
    if (!state.visible) return true;
    for (const axis of AXES) {
      const m = state.axes[axis];
      const [size, total] = sizes(el, axis);
      const needed = m.needed;
      if (size !== m.size) return false;
      if (total !== m.total) sizeThumb(m, size, total);
      if (m.needed !== needed) return false;
      m.scroll = scrollOf(el, axis);
    }
    return true;
  }

  function fullPass() {
    for (const [el, state] of surfaces) {
      if (el.isConnected) continue;
      Object.values(state.bars).forEach(data => data.bar.remove());
      resize.unobserve(el);
      surfaces.delete(el);
      el.classList.remove('overlay-scroll-surface');
    }
    const list = [...surfaces];
    let moving = false;
    for (const [el, state] of list) {
      state.nested = list.some(([other]) => other !== el && el.contains(other));
      if (measure(el, state)) moving = true;
    }
    list.forEach(([el, state]) => hitTest(el, state));
    list.forEach(([el, state]) => write(el, state));
    if (moving) queueFull();
  }

  function paintActive() {
    const now = performance.now();
    let nextFade = Infinity;
    for (const state of surfaces.values()) {
      for (const data of Object.values(state.bars)) {
        const m = state.axes[data.axis];
        if (data.bar.hidden || !m) continue;
        const { clip, left, top, width, height } = m;
        const near = pointer && (data.axis === 'vertical'
          ? Math.abs(pointer.x - (left + width)) <= 24 && pointer.y >= clip.top && pointer.y <= clip.bottom
          : Math.abs(pointer.y - (top + height)) <= 24 && pointer.x >= clip.left && pointer.x <= clip.right);
        data.bar.classList.toggle('active', Boolean(near || state.until > now || dragging?.data === data));
        data.bar.classList.toggle('dragging', dragging?.data === data);
      }
      if (state.until > now) nextFade = Math.min(nextFade, state.until);
    }
    clearTimeout(fadeTimer);
    if (Number.isFinite(nextFade)) fadeTimer = setTimeout(queue, Math.max(1, nextFade - performance.now()));
  }

  function update() {
    frame = 0;
    // Inspect changed subtrees once per frame, not the whole transcript on each scroll.
    for (const root of dirty) {
      if (!root?.isConnected || isOverlay(root)) continue;
      if (register(root)) full = true;
      root.querySelectorAll?.('*').forEach(el => { if (register(el)) full = true; });
    }
    dirty.clear();
    changedElements.forEach(el => { if (register(el)) full = true; });
    changedElements.clear();
    if (!full) {
      const quick = [...touched].map(el => [el, surfaces.get(el)]);
      if (quick.every(([el, state]) => state && remeasure(el, state))) {
        quick.forEach(([, state]) => {
          if (!state.visible) return;
          for (const data of Object.values(state.bars)) if (state.axes[data.axis].needed) writeThumb(state, data, state.axes[data.axis]);
        });
      } else full = true;
    }
    touched.clear();
    if (full) {
      full = false;
      fullPass();
    }
    paintActive();
  }

  const surfaceOf = node => {
    // An attribute change on <html> passes its parentElement: null.
    for (let el = node instanceof Element ? node : node?.parentElement; el; el = el.parentElement) if (surfaces.has(el)) return el;
    return null;
  };

  new MutationObserver(records => {
    let changed = false, content = false;
    for (const record of records) {
      if (isOverlay(record.target)) continue;
      changed = true;
      const attribute = record.type === 'attributes';
      if (attribute) changedElements.add(record.target);
      for (const node of record.addedNodes) if (node instanceof Element && !isOverlay(node)) dirty.add(node);
      // Streamed text inside a surface only changes that surface's content size.
      const owner = surfaceOf(attribute ? record.target.parentElement : record.target);
      if (owner) { touched.add(owner); content = true; } else full = true;
    }
    if (!changed) return;
    // Content can still cover another surface's handle: re-check everything a little later.
    if (content && !settleTimer) settleTimer = setTimeout(() => { settleTimer = 0; queueFull(); }, 200);
    queue();
  }).observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'inert'] });
  document.addEventListener('scroll', event => {
    const state = surfaces.get(event.target);
    if (state) {
      state.until = performance.now() + 900;
      touched.add(event.target);
    } else full = true;
    queue();
  }, true);
  document.addEventListener('pointermove', event => {
    pointer = { x: event.clientX, y: event.clientY };
    queue();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; queue(); });
  window.addEventListener('blur', () => { pointer = null; queue(); });
  document.addEventListener('load', queueFull, true);
  window.addEventListener('resize', queueFull);
  queue();
})();
