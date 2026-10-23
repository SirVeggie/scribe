import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/newpage.js", import.meta.url), "utf8");

function screen(webgl = true, restoring = false, hostOverrides: Record<string, any> = {}) {
  let selected = "nebula";
  let working = false;
  let step: (dt: number) => void = () => {};
  const motionChanges: (() => void)[] = [];
  let running = false;
  let uiEffects = true;
  const events: Record<string, (event?: any) => void> = {};
  let provider = "claude";
  let providerColors: string | null = null;
  const palettes: Record<string, string[]> = {
    claude: ["#2a0a06", "#a8321a", "#f08a2c", "#ffe1a6"],
    codex: ["#0d2a5c", "#3b82f6", "#93c5fd", "#fff7d6"],
  };
  const themeColors: Record<string, string> = { "--fx-1": "66,61,209", "--fx-2": "148,77,250", "--fx-3": "82,163,255" };
  const uniforms: Record<string, any> = {};
  const classes = new Set<string>();
  const css: Record<string, string> = {};
  const draws: { u_time: number; u_motionTime: number; u_work: number }[] = [];
  const shaders: string[] = [];
  let activeShader = "";
  const animations: { finished: Promise<void>; finish: () => void; cancelled: boolean; cancel: () => void }[] = [];
  const timers = new Map<number, () => void>();
  const warmTimers = new Map<number, () => void>();
  let timerId = 0;
  let now = 0;
  let intent: { itemId: string; title: string } | null = null;
  const deadlines = new Map<number, number>();
  let hidden = false;
  const effects: { canvas: any; destroyed: boolean; ready: () => void; fail: () => void }[] = [];
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { motionChanges.push(fn); } };
  const node = () => ({
    hidden: false, inert: false, textContent: "", innerHTML: "",
    children: [] as any[], listeners: {} as Record<string, () => void>,
    dataset: {} as Record<string, string>, style: { cssText: "" },
    append(...children: any[]) { this.children.push(...children); },
    setAttribute() {},
    removeAttribute() {}, remove() {},
    classList: { toggle(_name: string, _on: boolean) {}, add(_name: string) {}, remove(_name: string) {} },
    addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; },
    replaceChildren(...children: any[]) { this.children = children; },
    cloneNode: () => node(), replaceWith() {}, querySelector: (_: string): any => node(),
  });
  const root = node();
  (root as any).animate = () => {
    let finish!: () => void;
    const animation = { finished: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish(), cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  root.classList.toggle = (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); };
  root.classList.add = (...names: string[]) => { names.forEach(name => classes.add(name)); };
  root.classList.remove = name => { classes.delete(name); };
  (root.classList as any).contains = (name: string) => classes.has(name);
  (root as any).style = {
    setProperty: (name: string, value: string) => { css[name] = value; },
    removeProperty: (name: string) => { delete css[name]; },
  };
  const parts = new Map<string, ReturnType<typeof node>>();
  root.querySelector = (key: string) => {
    if (!parts.has(key)) parts.set(key, node());
    return parts.get(key)!;
  };
  const win: any = {
    scribeMotion: { enabled: () => !motion.matches && uiEffects, reveal: (node: any) => node.animate(), animate: (node: any, frames: any, options: any) => {
      const animation = (root as any).animate();
      Object.assign(animation, { node, frames, options });
      return animation;
    } },
    matchMedia: () => motion,
    addEventListener: (name: string, fn: (event?: any) => void) => {
      const previous = events[name];
      events[name] = (event?: any) => { previous?.(event); fn(event); };
    },
    scribeOrb: { colors: (p: string) => palettes[p] },
    scribeGL: {
      lazy: (canvas: any, shader: string, opts: any) => {
        shaders.push(shader);
        const effect = { canvas, destroyed: false, ready: () => { canvas.dataset.ready = "1"; opts.onReady(); }, fail: () => opts.onError() };
        effects.push(effect);
        return { set: (values: any) => { activeShader = shader; Object.assign(uniforms, values); }, destroy() { effect.destroyed = true; }, draw: (values: any) => draws.push(values) };
      },
      loop: (fn: (dt: number) => void) => {
        step = fn;
        return { start: () => { running = true; }, stop: () => { running = false; } };
      },
    },
  };
  if (!webgl) delete win.scribeGL;
  class Observer { observe() {} }
  runInNewContext(source, {
    window: win, document: {
      createElement: () => node(),
      getElementById: () => root, documentElement: { hasAttribute: () => restoring, classList: { contains: (name: string) => name === "fx-off" && !uiEffects } },
      body: { appendChild() {} }, get hidden() { return hidden; },
      addEventListener: (name: string, fn: () => void) => { events[name] = fn; },
    },
    localStorage: { getItem: (key: string) => key === "scribe.newPageProviderColors" ? providerColors : selected }, matchMedia: () => motion,
    getComputedStyle: () => ({
      backgroundColor: "rgb(8, 8, 10)",
      getPropertyValue: (name: string) => themeColors[name] || "",
    }),
    MutationObserver: Observer, ResizeObserver: Observer,
    performance: { now: () => now },
    setTimeout: (fn: () => void, delay: number) => { const id = ++timerId; deadlines.set(id, now + delay); (delay === 1200 || delay === 250 ? warmTimers : timers).set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); warmTimers.delete(id); },
  });
  const page = win.createNewPage({
    templates: () => [], builtins: () => [], threads: () => 1, working: () => working,
    openChat() {},
    provider: () => provider,
    intent: () => intent,
    ...hostOverrides,
  });
  return {
    page, draws, shaders, motion, uniforms, classes, css, root, animations, timers, parts, events,
    intent: (value: typeof intent) => { intent = value; },
    activeShader: () => activeShader,
    frame: () => {
      const listeners = new Set<() => void>();
      return { dataset: {} as Record<string, string>, animate: (root as any).animate,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        load: () => [...listeners].forEach((fn) => fn()), listeners };
    },
    provider: (p: string) => { provider = p; events["scribe:dock-provider"]({ detail: { provider: p } }); },
    tint: (value: boolean) => { providerColors = value ? "1" : "0"; events["scribe:newpage-bg"](); },
    customize: () => { palettes.codex[1] = "#12ab34"; events["scribe:orb-appearance"](); },
    tick: (dt: number) => { if (running) step(dt); },
    busy: (value: boolean) => { working = value; },
    choose: (id: string) => { selected = id; events["scribe:newpage-bg"](); },
    reduce: (value: boolean) => { motion.matches = value; motionChanges.forEach(fn => fn()); },
    uiEffects: (value: boolean) => { uiEffects = value; events["scribe:ui-fx"](); },
    running: () => running,
    effects, warmTimers,
    advance: (ms: number) => {
      now += ms;
      for (const [id, fn] of [...timers]) {
        if (deadlines.get(id)! > now) continue;
        timers.delete(id);
        fn();
      }
    },
    warm: () => { for (const [id, fn] of [...warmTimers]) { warmTimers.delete(id); fn(); } },
    restored: () => { restoring = false; events["scribe:restored"](); },
    visibility: (value: boolean) => { hidden = value; events.visibilitychange(); },
  };
}

test("recent workspaces open the selected path and refresh when preferences arrive", () => {
  let dirs: string[] = [];
  const opened: string[] = [];
  const s = screen(false, false, { threads: () => 0, workspaces: () => dirs, openWorkspace: (dir: string) => opened.push(dir) });
  s.page.render({ id: "draft" });
  const grid = s.parts.get(".newpage-workspaces")!;
  const heading = s.parts.get(".newpage-workspaces-head")!;
  assert.equal(grid.hidden, true);
  assert.equal(heading.hidden, true);
  dirs = ["C:\\projects\\scribe", "/home/me/other/scribe"];
  s.events["scribe:threads-ready"]();
  assert.equal(grid.hidden, false);
  assert.equal(heading.hidden, false);
  assert.equal(grid.children.length, 2);
  assert.equal(grid.children[0].children[0].children[0].textContent, "scribe");
  assert.equal(grid.children[1].children[0].children[1].textContent, dirs[1]);
  grid.children[1].listeners.click();
  assert.deepEqual(opened, [dirs[1]]);
  const first = grid.children[0];
  s.page.render({ id: "draft" });
  assert.equal(grid.children[0], first, "unchanged lists keep their buttons and focus");
  dirs = [];
  s.events["scribe:workspaces-changed"]();
  assert.equal(grid.hidden, true);
  assert.equal(heading.hidden, true);
});

test("workspace shortcuts start a floating draft with saved defaults", () => {
  const agent = readFileSync(new URL("../public/agent.js", import.meta.url), "utf8");
  const source = agent.slice(agent.indexOf("  function openWorkspace(dir) {"), agent.indexOf("  /** A new thread with this text", agent.indexOf("  function openWorkspace(dir) {")));
  const calls: any[] = [];
  const context = {
    S: { fullOpen: true }, leaveFull: () => calls.push("leaveFull"), activeTab: () => ({ id: "draft" }),
    setDockPick: (...args: any[]) => calls.push(["pick", ...args]),
    dock: { view: { startDraft: (...args: any[]) => calls.push(["draft", ...args]), focus: () => calls.push("focus") }, setShown: (shown: boolean) => calls.push(["show", shown]) },
  };
  runInNewContext(`${source}\nopenWorkspace('C:/projects/scribe');`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    "leaveFull", ["pick", "draft", null], ["draft", { kind: "global", ref: null }, { cwd: "C:/projects/scribe" }], ["show", true], "focus",
  ]);
});

test("warmup waits for restoration, reuses one prepared effect and replenishes without animating it", () => {
  const s = screen(true, true);
  assert.equal(s.warmTimers.size, 0);
  assert.equal(s.shaders.length, 0);
  s.choose("nebula,aurora");
  s.restored();
  assert.equal(s.warmTimers.size, 1);
  assert.equal(s.shaders.length, 0);
  s.warm();
  assert.equal(s.shaders.length, 1);
  assert.equal(s.draws.length, 1);
  assert.equal(s.running(), false);
  const first = s.effects[0];
  first.ready();
  assert.equal(s.classes.has("gl"), false);
  s.page.render({ id: "first" });
  assert.equal(s.shaders.length, 1);
  assert.equal(s.classes.has("gl-warm"), true);
  assert.equal(first.destroyed, false);
  const firstShader = s.shaders[0];
  s.warm();
  assert.equal(s.shaders.length, 2);
  assert.notEqual(s.shaders[1], firstShader);
  s.effects[1].ready();
  s.page.render({ id: "second" });
  assert.equal(s.shaders.length, 2);
  assert.equal(first.destroyed, true);
  assert.equal(s.classes.has("gl-warm"), true);
  s.page.render(null);
  assert.equal(s.running(), false);
  s.warm();
  assert.equal(s.shaders.length, 3);
  assert.ok(s.effects.filter(effect => !effect.destroyed).length <= 2);
});

test("overlapping creations consume separate picks, replenish the spare and keep their picks on return", () => {
  const s = screen();
  s.choose("nebula,aurora,caustics");
  s.busy(true);
  s.warm();
  const first = s.effects[0];
  first.ready();
  s.page.render({ id: "first" }, true);
  s.warm();
  const second = s.effects[1];
  // Consume the next effect before it has finished compiling.
  s.page.render({ id: "second" }, true);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
  assert.equal(s.classes.has("gl"), false);
  second.ready();
  assert.equal(s.classes.has("gl"), true);
  s.warm();
  const third = s.effects[2];
  third.ready();
  s.page.render({ id: "third" });
  s.page.render({ id: "third" }, true);
  assert.equal(third.destroyed, false);
  assert.equal(new Set(s.shaders).size, 3);
  const spareCount = s.shaders.length;
  s.warm();
  assert.equal(s.shaders.length, spareCount + 1);
  s.page.render({ id: "first" }, true);
  assert.equal(s.activeShader(), s.shaders[0]);
  s.page.render({ id: "second" }, true);
  assert.equal(s.activeShader(), s.shaders[1]);
  assert.ok(s.effects.filter(effect => !effect.destroyed).length <= 2);
});

test("word transitions finish their exit before replacement and cancel when leaving or disabling motion", () => {
  const s = screen(false);
  s.intent({ itemId: "one", title: "A page" });
  s.page.render({ id: "first" });
  // No chat of its own (a Global chat makes it): the options still step aside for the status.
  assert.equal(s.classes.has("intent"), true);
  assert.equal(s.parts.get(".newpage-body")!.inert, true);
  const word = s.parts.get(".newpage-intent-word")!;
  assert.equal(word.textContent, "Imagining…");
  const first = s.animations.at(-1)! as any;
  assert.equal(first.frames[0].opacity, 0);
  assert.equal(first.frames.at(-1).opacity, 0);
  assert.equal(first.options.duration, 2600);
  s.advance(2599);
  assert.equal(word.textContent, "Imagining…");
  s.advance(1);
  assert.equal(word.textContent, "Sketching…");
  assert.equal(first.cancelled, true);
  const second = s.animations.at(-1)!;
  s.intent({ itemId: "one", title: "Updated title" });
  s.page.render({ id: "first" });
  assert.equal(second.cancelled, false);
  s.uiEffects(false);
  assert.equal(second.cancelled, true);
  assert.equal(s.timers.size, 0);
  s.uiEffects(true);
  const resumed = s.animations.at(-1)!;
  s.reduce(true);
  assert.equal(resumed.cancelled, true);
  assert.equal(s.timers.size, 0);
  s.reduce(false);
  const last = s.animations.at(-1)!;
  s.page.render(null);
  assert.equal(last.cancelled, true);
  assert.equal(s.timers.size, 0);
});

test("warmup defers while hidden, discards disabled effects and reuses a single selected style", () => {
  const s = screen();
  s.visibility(true);
  s.warm();
  assert.equal(s.shaders.length, 0);
  s.visibility(false);
  s.warm();
  const stale = s.effects[0];
  s.choose("aurora");
  s.warm();
  assert.equal(stale.destroyed, true);
  assert.equal(s.shaders.length, 2);
  s.effects[1].ready();
  s.page.render({ id: "first" });
  s.warm();
  s.page.render({ id: "second" });
  s.warm();
  assert.equal(s.shaders.length, 2);
});

test("failed warmups keep the fallback and a cold shader completed while hidden is ready on return", () => {
  const s = screen();
  s.warm();
  s.effects[0].fail();
  s.page.render({ id: "draft" });
  assert.equal(s.effects[0].destroyed, true);
  assert.equal(s.classes.has("gl"), false);
  s.page.render(null);
  s.effects[1].ready();
  assert.equal(s.classes.has("gl"), false);
  s.page.render({ id: "draft" });
  assert.equal(s.shaders.length, 2);
  assert.equal(s.classes.has("gl-warm"), true);
});

test("replacement waits for load, survives rerenders and stops the backdrop after fading", async () => {
  const s = screen();
  const frame = s.frame();
  s.page.render({ id: "draft" });
  s.page.replace({ id: "draft" }, frame);
  s.page.replace({ id: "draft" }, frame);
  assert.equal(s.root.hidden, false);
  assert.equal(frame.listeners.size, 1);
  assert.equal(s.animations.length, 0);
  frame.load();
  assert.equal(s.animations.length, 2);
  assert.equal(s.timers.size, 0);
  s.animations.forEach((animation) => animation.finish());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.root.hidden, true);
  assert.equal(s.running(), false);
});

test("switching pages cancels a pending replacement and reduced motion skips the fade", () => {
  const s = screen();
  const frame = s.frame();
  s.page.render({ id: "draft" });
  s.page.replace({ id: "draft" }, frame);
  s.page.render({ id: "other" });
  assert.equal(frame.listeners.size, 0);
  assert.equal(s.timers.size, 0);
  frame.load();
  assert.equal(s.animations.length, 0);
  s.reduce(true);
  frame.dataset.loaded = "1";
  s.page.replace({ id: "other" }, frame);
  assert.equal(s.root.hidden, true);
  assert.equal(s.animations.length, 0);
});

test("working intensity eases in and out while drift keeps its pace and hidden screens stop", () => {
  const s = screen();
  s.page.render({ id: "draft" });
  s.tick(.1);
  const idle = s.draws.at(-1)!;
  assert.equal(idle.u_work, 0);
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const busy = s.draws.at(-1)!;
  assert.ok(busy.u_work > 0 && busy.u_work < 1);
  assert.ok(Math.abs(busy.u_time - idle.u_time - .1) < 1e-10);
  s.busy(false);
  s.page.render({ id: "draft" });
  s.tick(.1);
  assert.ok(s.draws.at(-1)!.u_work < busy.u_work);
  s.page.render(null);
  const count = s.draws.length;
  s.tick(.1);
  assert.equal(s.running(), false);
  assert.equal(s.draws.length, count);
});

test("UI effects off freezes the backdrop on entry and live changes resume only visible, moving screens", () => {
  const s = screen();
  s.uiEffects(false);
  s.page.render({ id: "draft" });
  assert.equal(s.running(), false);
  assert.ok(s.draws.length > 0);
  const count = s.draws.length;
  s.tick(1);
  assert.equal(s.draws.length, count);
  s.uiEffects(true);
  assert.equal(s.running(), true);
  s.tick(.1);
  assert.ok(s.draws.length > count);
  s.uiEffects(false);
  assert.equal(s.running(), false);
  const frozen = s.draws.length;
  s.tick(1);
  assert.equal(s.draws.length, frozen);
  s.reduce(true);
  s.uiEffects(true);
  assert.equal(s.running(), false);
  s.page.render(null);
  s.reduce(false);
  s.uiEffects(false);
  s.uiEffects(true);
  assert.equal(s.running(), false);
});

test("provider palettes update live, preserve the shader and use theme colors when disabled", () => {
  const s = screen();
  s.reduce(true);
  s.page.render({ id: "draft" });
  assert.equal(s.classes.has("provider-colors"), false, "fresh profiles use background colours");
  assert.equal(s.css["--np-c1"], undefined);
  s.tint(true);
  assert.equal(s.uniforms.u_tint, 1);
  assert.equal(s.css["--np-c1"], "168,50,26");
  const count = s.shaders.length;
  const time = s.draws.at(-1)!.u_time;
  s.provider("codex");
  assert.equal(s.css["--np-c1"], "59,130,246");
  assert.equal(s.uniforms.u_c1.join(","), [59 / 255, 130 / 255, 246 / 255].join(","));
  s.customize();
  assert.equal(s.css["--np-c1"], "18,171,52");
  assert.equal(s.shaders.length, count);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.tint(false);
  assert.equal(s.uniforms.u_tint, 1);
  assert.equal(s.uniforms.u_c1.join(","), [66 / 255, 61 / 255, 209 / 255].join(","));
  assert.equal(s.css["--np-c1"], undefined);
  assert.equal(s.classes.has("provider-colors"), false);
  s.provider("claude");
  assert.equal(s.uniforms.u_c1.join(","), [66 / 255, 61 / 255, 209 / 255].join(","));
  s.tint(true);
  assert.equal(s.uniforms.u_tint, 1);
  assert.equal(s.css["--np-c1"], "168,50,26");
});

test("Bokeh drift speeds up gently without jumping on working changes, and freezes with reduced motion", () => {
  const s = screen();
  s.choose("bokeh");
  s.page.render({ id: "draft" });
  s.tick(.1);
  const idle = s.draws.at(-1)!;
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const entering = s.draws.at(-1)!;
  assert.ok(entering.u_motionTime - idle.u_motionTime > .1);
  assert.ok(entering.u_motionTime - idle.u_motionTime < .11);
  s.tick(1);
  const busy = s.draws.at(-1)!;
  assert.ok(Math.abs(busy.u_motionTime - entering.u_motionTime - 1.1) < 1e-10);
  s.busy(false);
  s.page.render({ id: "draft" });
  s.tick(.1);
  const leaving = s.draws.at(-1)!;
  assert.ok(leaving.u_motionTime - busy.u_motionTime > .1);
  assert.ok(leaving.u_motionTime - busy.u_motionTime < .11);
  s.reduce(true);
  s.busy(true);
  s.page.render({ id: "draft" });
  s.tick(1);
  assert.equal(s.draws.at(-1)!.u_motionTime, leaving.u_motionTime);
  assert.equal(s.draws.at(-1)!.u_work, 1);
});

test("CSS fallback follows providers and the setting without WebGL", () => {
  const s = screen(false);
  s.page.render({ id: "draft" });
  assert.equal(s.classes.has("provider-colors"), false);
  s.tint(true);
  assert.equal(s.classes.has("provider-colors"), true);
  s.provider("codex");
  assert.equal(s.css["--np-c2"], "147,197,253");
  s.tint(false);
  assert.equal(s.classes.has("provider-colors"), false);
  assert.equal(s.css["--np-c2"], undefined);
  s.page.render(null);
  s.provider("claude");
  assert.equal(s.classes.has("provider-colors"), false);
});

test("reduced motion freezes time, updates working state and preserves it across Settings changes", () => {
  const s = screen();
  s.reduce(true);
  s.page.render({ id: "draft" });
  const time = s.draws.at(-1)!.u_time;
  s.busy(true);
  s.page.render({ id: "draft" });
  assert.equal(s.running(), false);
  assert.equal(s.draws.at(-1)!.u_work, 1);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.choose("aurora");
  assert.match(s.shaders.at(-1)!, /u_work\*wave\*1\.4/);
  assert.equal(s.draws.at(-1)!.u_work, 1);
  s.choose("contours");
  assert.match(s.shaders.at(-1)!, /line\*wave\*u_work/);
  assert.equal(s.draws.at(-1)!.u_time, time);
  s.reduce(false);
  assert.equal(s.running(), true);
  s.tick(.1);
  assert.ok(s.draws.at(-1)!.u_time > time);
});

test("the creating screen covers a page, takes a fresh background and dissolves into the page that opens", async () => {
  const s = screen();
  const made = s.frame();
  s.page.render({ id: "notes" }, true);
  assert.equal(s.root.hidden, false);
  assert.equal(s.classes.has("cover"), true);
  assert.equal(s.classes.has("has-thread"), true);
  assert.equal(s.running(), true);
  // One fade in, and none again for a re-render of the same cover.
  assert.equal(s.animations.length, 1);
  s.page.render({ id: "notes" }, true);
  assert.equal(s.animations.length, 1);
  s.tick(5);
  s.advance(5000);
  assert.ok(s.draws.at(-1)!.u_work > 0.9);
  // Another page comes to the front: the screen holds until it loads, then fades over it.
  s.page.replace({ id: "made" }, made);
  assert.equal(s.root.hidden, false);
  made.load();
  assert.equal(s.animations.length, 3);
  s.animations.forEach((animation) => animation.finish());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.root.hidden, true);
  assert.equal(s.running(), false);
});

test("a page that is not covered still drops the screen at once for another page", () => {
  const s = screen();
  s.page.render({ id: "draft" });
  s.page.replace({ id: "other" }, s.frame());
  assert.equal(s.root.hidden, true);
});

test("adding a creating overlay keeps the visible shader and does not fade it in again", () => {
  const s = screen();
  s.choose("nebula,aurora");
  s.page.render({ id: "draft" });
  const effect = s.effects.at(-1)!;
  const shaders = s.shaders.length;
  s.page.render({ id: "draft" }, true);
  s.page.render({ id: "draft" }, true);
  assert.equal(s.shaders.length, shaders);
  assert.equal(effect.destroyed, false);
  assert.equal(s.animations.length, 0);
});

test("a fast creating screen stays for 1.5 seconds across rerenders before revealing a loaded page", async () => {
  const s = screen();
  const frame = s.frame();
  s.page.render({ id: "notes" }, true);
  s.advance(600);
  s.page.render({ id: "notes" }, true);
  s.page.replace({ id: "made" }, frame);
  frame.load();
  assert.equal(s.animations.length, 1);
  s.advance(899);
  assert.equal(s.animations.length, 1);
  assert.equal(s.root.hidden, false);
  s.advance(1);
  assert.equal(s.animations.length, 3);
  s.animations.forEach(animation => animation.finish());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.root.hidden, true);
});

test("minimum creation time applies without motion and is cancelled when navigating away", () => {
  const s = screen(false);
  s.reduce(true);
  const frame = s.frame();
  frame.dataset.loaded = "1";
  s.page.render({ id: "notes" }, true);
  s.page.replace({ id: "made" }, frame);
  assert.equal(s.root.hidden, false);
  s.advance(1500);
  assert.equal(s.root.hidden, true);
  s.page.render({ id: "notes" }, true);
  s.page.replace({ id: "made" }, frame);
  s.page.render(null);
  assert.equal(s.timers.size, 0);
  s.advance(1500);
  assert.equal(s.animations.length, 0);
});
