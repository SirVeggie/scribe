import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";

test("page links send middle-click opens to background tabs", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Middle-click links test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.route("http://links.test/**", route => route.fulfill({ contentType: "text/html", body:
      route.request().url().endsWith("/frame")
        ? `<a data-scribe-open="scribe:target#card=12" data-scribe-mode="peek"><span>Target</span></a><script>window.__SCRIBE_BOOT__={id:'source',capture:true};</script><script>${BOARD_BRIDGE_JS}</script>`
        : '<iframe src="/frame"></iframe>'
    }));
    await page.goto("http://links.test/");
    await page.evaluate(() => {
      (window as any).opens = [];
      window.addEventListener("message", event => {
        if (event.data.type === "scribe-open") (window as any).opens.push(event.data);
        if (event.data.reqId) (event.source as Window).postMessage({
          type: event.data.type + "-result", reqId: event.data.reqId, ok: true, pages: {}
        }, "*");
      });
    });
    const link = page.frameLocator("iframe").locator("a span");
    await link.click({ button: "middle" });
    await page.waitForFunction(() => (window as any).opens.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).opens.map(({ target, mode, background, anchor }: any) => ({ target, mode, background, anchor }))),
      [{ target: "scribe:target", mode: "tab", background: true, anchor: "card=12" }]);
    await link.click({ modifiers: ["Control"] });
    await page.waitForFunction(() => (window as any).opens.length === 2);
    assert.equal(await page.evaluate(() => (window as any).opens[1].background), false);
    await link.click();
    await page.waitForFunction(() => (window as any).opens.length === 3);
    assert.equal(await page.evaluate(() => (window as any).opens[2].mode), "peek");
    await link.click({ button: "right" });
    assert.equal(await page.evaluate(() => (window as any).opens.length), 3);
    assert.equal(page.context().pages().length, 1);
  } finally {
    await browser.close();
  }
});

test("peeks stay with their tab; split panes can be focused, arranged and replaced by pointer drag", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Page views test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route("http://views.test/**", route => route.fulfill({ contentType: "text/html", body: '<main style="width:1100px;height:700px"></main>' }));
    await page.goto("http://views.test/");
    // tsx's named-function helper must also exist inside serialized evaluate callbacks.
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/pointer-drag.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/motion.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/views.js", import.meta.url), "utf8") });
    const result = await page.evaluate(async () => {
      const w = window as any;
      const mainEl = document.querySelector("main")!;
      const pages = new Map(["a", "b", "c", "d"].map(id => [id, { id, title: id }]));
      const frames = new Map<string, { el: HTMLIFrameElement }>();
      let active: string | null = "a", space = "default", spaceIds = ["default"];
      let draft: { id: string, title: string, draft: boolean } | null = null;
      let views: any;
      const select = (id: string) => { views.onSelect(id); active = id; views.layout(); };
      const host = {
        mainEl, isPageOrigin: (origin: string) => origin === location.origin,
        tabs: () => [...pages.values()], closed: () => [],
        findAnyTab: (id: string) => pages.get(id) || (draft?.id === id ? draft : null),
        activeId: () => active, activeTab: () => pages.get(active!) || (draft?.id === active ? draft : null),
        isBlank: (tab: any) => Boolean(tab?.draft), draftId: () => draft?.id || null,
        activate: (id: string) => select(id),
        newPage: async ({ beforeRender }: any = {}) => { draft = { id: "new", title: "New page", draft: true }; active = "new"; beforeRender?.(); views.layout(); return true; },
        spaceId: () => space, spaceIds: () => spaceIds,
        frame: (id: string) => frames.get(id), frameIds: () => [...frames.keys()],
        ensureFrame: (meta: any) => {
          if (!frames.has(meta.id)) {
            const el = document.createElement("iframe");
            mainEl.append(el);
            frames.set(meta.id, { el });
          }
          return frames.get(meta.id);
        },
        discardFrame: (id: string) => { frames.get(id)?.el.remove(); frames.delete(id); },
        selectTab: select, openPage: select, showNotice: () => {}, linkMode: () => "tab",
        markSeen: () => {}, render: () => views.layout(),
      };
      views = w.createViews(host);
      const shown = () => [...views.shownIds()].sort().join(",");
      const observations: Record<string, unknown> = {};
      await views.open("c", "peek");
      const middleMode = views.modeFromEvent({ button: 1, shiftKey: true, altKey: true });
      await views.open("b", middleMode, { background: true, source: { role: "peek" } });
      observations.backgroundFromPeek = [active, shown(), middleMode];
      await views.open("d", "peek", { source: { role: "peek" } });
      const originalFrame = frames.get("d")!.el;
      select("b");
      observations.otherTab = shown();
      observations.escapeOtherTab = views.escape();
      await views.open("c", "peek");
      select("a");
      observations.originalTab = shown();
      observations.sameFrame = frames.get("d")!.el === originalFrame;
      (mainEl.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
      observations.back = shown();
      spaceIds = ["one", "two"]; space = "one";
      views.prune(); views.layout();
      observations.firstSpace = shown();
      space = "two"; views.prune(); views.layout();
      observations.otherSpaceSameTab = shown();
      // A split replaces the pane without focus; picking another tab changes the focused one.
      const panes = () => ["a", "b"].map(pane => [...frames].find(([, f]) => f.el.dataset.pane === pane)?.[0] || "-").join("");
      const focused = () => (mainEl.querySelector(".pane-head.focused") as HTMLElement)?.dataset.pane;
      const click = (label: string, pane?: string) =>
        (mainEl.querySelector(`${pane ? `.pane-head[data-pane="${pane}"] ` : ""}[aria-label="${label}"]`) as HTMLButtonElement).click();
      await views.open("d", "split");
      observations.split = [panes(), focused(), active];
      select("b");
      observations.selectChangesFocusedPane = [panes(), focused()];
      // Picking the other pane's tab, or pressing in its page, moves focus there; nothing moves on screen.
      select("d");
      observations.selectOtherPane = [panes(), focused(), active];
      views.onFrameActive("b");
      observations.pressInPane = [panes(), focused(), active];
      mainEl.querySelector('.pane-head[data-pane="b"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      observations.pressOnHeader = [focused(), active];
      // Focus that arrives by another route (Back, an agent's focus request) is followed too.
      active = "b"; views.layout();
      observations.focusByOtherRoute = [panes(), focused()];
      click("Swap panes");
      observations.swapped = [panes(), focused(), active];
      click("Stack panes");
      observations.stacked = [mainEl.classList.contains("split-col"), mainEl.querySelector(".split-divider")!.getAttribute("aria-orientation")];
      click("Show side by side");
      // The split is its space's: another space has none, and coming back restores it.
      space = "one"; active = "b"; views.prune(); views.layout();
      observations.otherSpace = shown();
      views.closePeek();
      space = "two"; views.prune(); views.layout();
      observations.restoredSplit = [panes(), focused()];
      // Either pane can be closed; its page stays a tab and the other pane fills the page area.
      click("Close pane", "b");
      observations.closeFocused = [shown(), active];
      await views.open("b", "split");
      click("Close pane", "b");
      observations.closeOther = [shown(), active];
      // Closing a pane's tab ends the split on the other pane.
      await views.open("b", "split");
      observations.closedTabNeighbor = views.returnTarget("d");
      views.onClosed("b"); views.layout();
      observations.closedOtherTab = shown();
      // Splitting the tab you are on opens a New page beside it, with focus.
      await views.open("d", "split");
      observations.splitActive = [shown(), focused(), active, panes()];
      select("d");
      observations.newPageKeptBeside = [shown(), focused()];
      click("Close pane", "b");
      draft = null;
      // A pane as a peek, and back.
      await views.open("a", "split");
      click("Show as peek", "b");
      observations.paneToPeek = [shown(), mainEl.classList.contains("has-split"), mainEl.classList.contains("has-peek")];
      click("Show in split");
      observations.peekToSplit = [panes(), mainEl.classList.contains("has-peek")];
      // Reloading keeps the split; a deleted page ends it.
      views = w.createViews(host); views.prune(); views.layout();
      observations.afterReload = [panes(), focused()];
      pages.delete("a"); views.onDeleted("a"); views.layout();
      observations.deletedTarget = shown();
      views = w.createViews(host); views.prune(); views.layout();
      observations.deletedSplitNotRestored = shown();
      await views.open("b", "split");
      spaceIds = ["one"]; space = "one"; views.prune(); views.layout();
      observations.deletedSpaceRemoved = localStorage.getItem("scribe.spaceSplits");
      // Pointer drop zones cover frames; arranging and replacing reuse the frame pool.
      select("b");
      await views.open("c", "split");
      const keptFrame = frames.get("c")!.el;
      const box = mainEl.getBoundingClientRect();
      views.beginPageDrag({ pane: "b" });
      const topDrop = views.updatePageDrag(box.left + box.width / 2, box.top + 5);
      observations.edgeDrop = topDrop;
      observations.overlayVisible = [...mainEl.querySelectorAll(".pane-drop-overlay")].some(el => !(el as HTMLElement).hidden);
      views.endPageDrag();
      await views.dropPage({ pane: "b" }, topDrop);
      observations.dragStack = [panes(), mainEl.classList.contains("split-col")];
      views.beginPageDrag({ id: "d" });
      observations.expandedSplitTarget = views.updatePageDrag(box.left + box.width / 2, box.top + box.height * 0.12);
      const replace = views.updatePageDrag(box.left + box.width / 2, box.top + box.height / 4);
      await views.dropPage({ id: "d" }, replace);
      views.endPageDrag();
      observations.dragReplace = [panes(), active];
      observations.compactReplaceTarget = replace;
      await views.dropPage({ id: "d" }, { edge: "right" });
      observations.dragRight = [panes(), mainEl.classList.contains("split-col")];
      views.beginPageDrag({ pane: "a" });
      observations.noDropOutside = views.updatePageDrag(box.right + 20, box.bottom + 20);
      views.endPageDrag();
      observations.cancelKeepsLayout = panes();
      await views.dropPage({ pane: "b" }, { strip: true });
      observations.dragToStrip = [shown(), pages.has("d"), frames.get("c")!.el === keptFrame];
      views.beginPageDrag({ id: "c" });
      await views.dropPage({ id: "c" }, { edge: "left" });
      views.endPageDrag();
      observations.dragTabToSplit = [panes(), active];
      await views.dropPage({ pane: "b" }, { strip: true });
      await views.dropPage({ id: "c" }, { edge: "bottom" });
      observations.dragOnlyTab = [shown(), mainEl.classList.contains("split-col")];
      observations.overlayCleaned = [(mainEl.querySelector(".pane-drop-overlay") as HTMLElement).hidden, document.body.classList.contains("dragging-pane")];
      return observations;
    });
    assert.deepEqual(result, {
      backgroundFromPeek: ["a", "a,c", "tab"],
      otherTab: "b", escapeOtherTab: false, originalTab: "a,d", sameFrame: true, back: "a,c",
      firstSpace: "a,c", otherSpaceSameTab: "a",
      split: ["ad", "a", "a"], selectChangesFocusedPane: ["bd", "a"],
      selectOtherPane: ["bd", "b", "d"], pressInPane: ["bd", "a", "b"], pressOnHeader: ["b", "d"],
      focusByOtherRoute: ["bd", "a"], swapped: ["db", "b", "b"], stacked: [true, "horizontal"],
      otherSpace: "b,c", restoredSplit: ["db", "b"],
      closeFocused: ["d", "d"], closeOther: ["d", "d"],
      closedTabNeighbor: "b", closedOtherTab: "d",
      splitActive: ["d,new", "b", "new", "d-"], newPageKeptBeside: ["d,new", "a"],
      paneToPeek: ["a,d", false, true], peekToSplit: ["da", false],
      afterReload: ["da", "a"], deletedTarget: "d", deletedSplitNotRestored: "d",
      deletedSpaceRemoved: "{}",
      edgeDrop: { edge: "top" }, overlayVisible: true, dragStack: ["cb", true],
      expandedSplitTarget: { edge: "top", at: 0 }, compactReplaceTarget: { pane: "a" },
      dragReplace: ["db", "b"], dragRight: ["bd", false], noDropOutside: null,
      cancelKeepsLayout: "bd", dragToStrip: ["b", true, true], dragTabToSplit: ["cb", "b"],
      dragOnlyTab: ["c,new", true], overlayCleaned: [true, false],
    });
    // Exercise the actual app.js controller with mouse input, including crossing live iframes.
    await page.setContent('<div id="strip" class="tabs-wrap"><div id="tabs"></div></div><main></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") + '\n#strip {height:50px} #tabs {display:flex;height:50px} main {position:relative;width:1100px;height:650px} .tab {width:150px;height:40px} iframe {position:absolute;inset:40px 0 0;width:100%;height:90%}' });
    const appSource = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const controller = appSource.slice(appSource.indexOf("  function onTabPointerDown("), appSource.indexOf('  /**\n   * Library row dragged over the strip'));
    await page.addScriptTag({ content: `{
      const state = { tabs: ['a','b','c'].map(id => ({id,title:id,pinned:false})), closed: [], activeId:'a' };
      const mainEl = document.querySelector('main'), tabsEl = document.querySelector('#tabs'), tabsWrap = document.querySelector('#strip');
      const libraryToggle = document.createElement('button'), tabEls = new Map(), frames = new Map();
      let drag = null, dragScrollTimer = 0, toggleHoverTimer = 0, dragSuppressClick = false;
      const popped = [];
      const popout = {desktop:false,supported:true,has:()=>false,open(tab,at){popped.push({id:tab.id,at});views.onPopOut(tab.id);views.layout();return true;}};
      const findAnyTab = id => [...state.tabs,...state.closed].find(tab=>tab.id===id);
      const isBlank = tab => Boolean(tab?.draft), showNotice = () => {};
      const hoverCard = {suspend(){},resume(){}}, library = {stripDragCancel(){},stripDragMove(){return false},stripDragDrop(){return false}};
      const lookupTab = el => state.tabs.find(t => t.id === el.dataset.id);
      const stopTabScroll = () => {}, updateTabFade = () => {}, flipStrip = fn => fn();
      const libraryShown = () => false, setSidebarTab = () => {}, setSideOpen = () => {};
      const select = id => { views.onSelect(id); state.activeId=id; views.layout(); };
      const renderTabs = () => { for(const tab of state.tabs) tabsEl.appendChild(tabEls.get(tab.id)); };
      const views = window.createViews({mainEl,startPaneDrag,isPageOrigin:(origin)=>origin===location.origin,
        tabs:()=>state.tabs,closed:()=>[],activeId:()=>state.activeId,activeTab:()=>state.tabs.find(t=>t.id===state.activeId),
        findAnyTab,isBlank,draftId:()=>null,
        spaceId:()=> 'pointer-test',spaceIds:()=>['pointer-test'],activate:select,selectTab:select,
        frame:id=>frames.get(id),frameIds:()=>[...frames.keys()],ensureFrame:meta=>{
          if(!frames.has(meta.id)){const el=document.createElement('iframe');mainEl.appendChild(el);frames.set(meta.id,{el});}
          return frames.get(meta.id);
        },discardFrame:()=>{},markSeen:()=>{},render:()=>views.layout()
      });
      for(const tab of state.tabs){ const el=document.createElement('div');el.className='tab';el.dataset.id=tab.id;el.textContent=tab.title;
        el.addEventListener('pointerdown',e=>onTabPointerDown(e,el));tabEls.set(tab.id,el); }
      renderTabs(); views.layout();
      window.addEventListener('keydown',e=>{if(e.key==='Escape')abortDrag();});
      window.dragTest = {views,state,frames,popout,popped};
      ${controller}
    }` });
    const moveDrag = async (selector: string, x: number, y: number) => {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect);
      await page.mouse.move(rect.x + 40, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + 50, rect.y + rect.height / 2);
      await page.mouse.move(x, y, { steps: 5 });
    };
    const area = await page.locator('main').boundingBox();
    assert.ok(area);
    await page.route('**/api/tabs/*/reorder', route => route.fulfill({ json: { ok: true } }));
    await moveDrag('.tab[data-id="b"]', 440, area.y + 20);
    assert.equal(await page.locator('.pane-drop-preview').evaluate(el => (el as HTMLElement).hidden), true);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => (window as any).dragTest.state.tabs.map((tab: any) => tab.id)), ['a', 'c', 'b']);
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    // Beyond the grace band, the same horizontal position offers a top split.
    await moveDrag('.tab[data-id="b"]', 440, area.y + 35);
    assert.equal(await page.locator('.pane-drop-label').textContent(), 'Place top');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await moveDrag('.tab[data-id="b"]', area.x + area.width - 5, area.y + area.height / 2);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), true);
    // Hover shows swap/stack; a divider being dragged hides them and shows its sizes.
    assert.deepEqual(await page.evaluate(() => {
      const divider = document.querySelector('.split-divider')!;
      const tools = document.querySelector('.split-tools') as HTMLElement;
      const ratio = document.querySelector('.split-ratio') as HTMLElement;
      const sample = () => ({ tools: getComputedStyle(tools).opacity, ratio: getComputedStyle(ratio).opacity });
      tools.style.transition = ratio.style.transition = "none";
      divider.classList.add("hot");
      const hovered = sample();
      document.body.classList.add("resizing-split");
      divider.classList.add("resizing");
      const dragging = sample();
      document.body.classList.remove("resizing-split");
      divider.classList.remove("resizing");
      divider.classList.remove("hot");
      tools.style.transition = ratio.style.transition = "";
      return { hovered, dragging };
    }), { hovered: { tools: "1", ratio: "0" }, dragging: { tools: "0", ratio: "1" } });
    await moveDrag('.pane-head[data-pane="b"]', area.x + area.width / 2, area.y + 5);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('split-col')), true);
    await moveDrag('.tab[data-id="c"]', area.x + area.width / 2, area.y + area.height * 0.75);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => (window as any).dragTest.frames.get('c').el.dataset.pane), 'b');
    await moveDrag('.pane-head[data-pane="b"]', 80, 25);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#strip')!, '::after').opacity === '1');
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.tab').count(), 3);
    // The preview rim is inset and follows the page surface, including at outer corners.
    await page.locator('main').evaluate(el => (el as HTMLElement).style.borderRadius = '24px');
    await moveDrag('.tab[data-id="b"]', area.x + 5, area.y + 200);
    const rim = await page.locator('.pane-drop-preview').evaluate(el => {
      const box = el.getBoundingClientRect(), surface = el.parentElement!.parentElement!.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { inset: box.left - surface.left, topRadius: style.borderTopLeftRadius, bottomRadius: style.borderBottomLeftRadius, seamRadius: style.borderTopRightRadius };
    });
    assert.deepEqual(rim, { inset: 6, topRadius: '18px', bottomRadius: '18px', seamRadius: '10px' });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.pane-drop-overlay').evaluate(el => (el as HTMLElement).hidden), true);
    assert.equal(await page.evaluate(() => document.body.classList.contains('dragging-pane')), false);
    await moveDrag('.tab[data-id="b"]', area.x + 5, area.y + 200);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.tab').count(), 3);
    // Self-replacement and peek centre drops have no preview or layout effect.
    const activeId = await page.evaluate(() => (window as any).dragTest.state.activeId);
    await moveDrag(`.tab[data-id="${activeId}"]`, area.x + area.width / 2, area.y + area.height / 2);
    assert.equal(await page.locator('.pane-drop-preview').evaluate(el => (el as HTMLElement).hidden), true);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    const peekId = await page.evaluate(async () => {
      const { views, state } = (window as any).dragTest;
      const id = state.tabs.find((tab: any) => tab.id !== state.activeId).id;
      await views.open(id, 'peek');
      for (const node of document.querySelectorAll('.peek-card, .peek-scrim, iframe')) {
        for (const animation of node.getAnimations()) animation.finish();
      }
      return id;
    });
    await moveDrag('.peek-card .view-head', area.x + area.width / 2, area.y + area.height / 2);
    assert.equal(await page.locator('.pane-drop-preview').evaluate(el => (el as HTMLElement).hidden), true);
    await page.mouse.up();
    assert.equal(await page.locator('.peek-card').evaluate(el => (el as HTMLElement).hidden), false);
    await moveDrag('.peek-card .view-head', area.x + area.width - 5, area.y + 200);
    assert.equal(await page.locator('.pane-drop-label').textContent(), 'Place right');
    await page.mouse.up();
    assert.equal(await page.locator('.peek-card').evaluate(el => (el as HTMLElement).hidden), true);
    assert.equal(await page.evaluate(id => (window as any).dragTest.frames.get(id).el.dataset.pane, peekId), 'b');
    await moveDrag(`.tab[data-id="${peekId}"]`, area.x + area.width * 0.75, area.y + area.height / 2);
    assert.equal(await page.locator('.pane-drop-preview').evaluate(el => (el as HTMLElement).hidden), true);
    await page.mouse.up();
    await page.evaluate(() => (window as any).dragTest.views.closeSplit());
    // Sample the real opening animation at fixed times, without timing-sensitive sleeps.
    const motion = await page.evaluate(async () => {
      const { views, frames, state } = (window as any).dragTest;
      const pool = document.createElement('div');
      pool.id = 'frames';
      document.querySelector('main')!.append(pool);
      for (const { el } of frames.values()) pool.append(el);
      const original = frames.get(state.activeId).el;
      for (const animation of original.getAnimations()) animation.finish();
      const width = original.getBoundingClientRect().width;
      const target = state.tabs.find((tab: any) => tab.id !== state.activeId).id;
      await views.open(target, 'split');
      const animation = original.getAnimations()[0];
      animation.pause();
      const samples = [0, 120, 240].map(time => {
        animation.currentTime = time;
        return original.getBoundingClientRect().width;
      });
      const entering = frames.get(target).el.getAnimations().length > 0;
      views.closeSplit();
      await Promise.resolve();
      const closing = original.getAnimations()[0];
      closing.pause();
      const closeSamples = [0, 120, 240].map(time => {
        closing.currentTime = time;
        return original.getBoundingClientRect().width;
      });
      closing.currentTime = 120;
      const interruptedWidth = original.getBoundingClientRect().width;
      await views.open(target, 'split');
      const reopenedWidth = original.getBoundingClientRect().width;
      const cancelled = closing.playState === 'idle';
      for (const node of document.querySelectorAll('[data-pane]')) for (const animation of node.getAnimations()) animation.finish();
      views.closeSplit();
      await Promise.resolve();
      for (const animation of original.getAnimations()) animation.finish();
      return { width, samples, entering, closeSamples, interruptedWidth, reopenedWidth, cancelled };
    });
    assert.ok(motion.samples.every((width: number) => Math.abs(width - area.width / 2) < 1));
    assert.ok(Math.abs(motion.samples[2] - area.width / 2) < 1);
    assert.equal(motion.entering, true);
    assert.ok(motion.closeSamples.every((width: number) => Math.abs(width - motion.width) < 1));
    assert.ok(Math.abs(motion.closeSamples[2] - motion.width) < 1);
    assert.ok(Math.abs(motion.reopenedWidth - area.width / 2) < 1);
    assert.equal(motion.cancelled, true);
    const stackedClose = await page.evaluate(async () => {
      const { views, frames, state } = (window as any).dragTest;
      const target = state.tabs.find((tab: any) => tab.id !== state.activeId).id;
      await views.open(target, 'split');
      (document.querySelector('[aria-label="Stack panes"]') as HTMLButtonElement).click();
      views.focusPane('b');
      const remaining = frames.get(target).el;
      const before = remaining.getBoundingClientRect();
      (document.querySelector('.pane-head[data-pane="a"] [aria-label="Close pane"]') as HTMLButtonElement).click();
      await Promise.resolve();
      const animation = remaining.getAnimations()[0];
      animation.pause(); animation.currentTime = 0;
      const start = remaining.getBoundingClientRect();
      animation.currentTime = 240;
      const end = remaining.getBoundingClientRect();
      animation.finish();
      return { beforeTop: before.top, startTop: start.top, beforeHeight: before.height, startHeight: start.height, endHeight: end.height, kept: frames.get(target).el === remaining };
    });
    assert.ok(Math.abs(stackedClose.beforeTop - stackedClose.startTop) < 1);
    assert.ok(stackedClose.startHeight > stackedClose.beforeHeight);
    assert.ok(Math.abs(stackedClose.endHeight - stackedClose.startHeight) < 1);
    assert.equal(stackedClose.kept, true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(async () => {
      const { views, frames, state } = (window as any).dragTest;
      await views.open(state.tabs.find((tab: any) => tab.id !== state.activeId).id, 'split');
      views.closeSplit();
      await Promise.resolve();
      return frames.get(state.activeId).el.getAnimations().length;
    }), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const peekMotion = await page.evaluate(async () => {
      const { views, frames, state } = (window as any).dragTest;
      const target = state.tabs.find((tab: any) => tab.id !== state.activeId).id;
      await views.open(target, 'peek');
      const frame = frames.get(target).el;
      const card = document.querySelector('.peek-card') as HTMLElement;
      const scrim = document.querySelector('.peek-scrim') as HTMLElement;
      // Finish opening before inspecting the exit animation.
      for (const node of [frame, card, scrim]) for (const animation of node.getAnimations()) animation.finish();
      views.closePeek();
      views.layout(); // Unrelated renders must keep the closing frame visible.
      const animations = [frame, card, scrim].map(node => node.getAnimations().find((animation: Animation) => !(animation as CSSAnimation).animationName)!);
      for (const animation of animations) animation.pause();
      const samples = [0, 80, 160].map(time => {
        for (const animation of animations) animation.currentTime = time;
        return [frame, card, scrim].map(node => Number(getComputedStyle(node).opacity));
      });
      const visibleDuringClose = !card.hidden && frame.dataset.role === 'peek' && frame.inert;
      const repeatedClose = views.closePeek();
      for (const animation of animations) animation.finish();
      await Promise.all(animations.map(animation => animation.finished));
      await Promise.resolve();
      const cleaned = card.hidden && scrim.hidden && frame.classList.contains('inactive') && !frame.inert;
      await views.open(target, 'peek');
      views.closePeek();
      const oldFinished = frame.getAnimations().map((animation: Animation) => animation.finished);
      await views.open(target, 'peek');
      await Promise.allSettled(oldFinished);
      return { samples, visibleDuringClose, repeatedClose, cleaned, reopened: !card.hidden && !frame.inert && frame === frames.get(target).el };
    });
    assert.deepEqual(peekMotion.samples[0], [1, 1, 1]);
    assert.ok(peekMotion.samples[1].every((opacity: number) => opacity > 0 && opacity < 1));
    assert.deepEqual(peekMotion.samples[2], [0, 0, 0]);
    assert.equal(peekMotion.visibleDuringClose, true);
    assert.equal(peekMotion.repeatedClose, true);
    assert.equal(peekMotion.cleaned, true);
    assert.equal(peekMotion.reopened, true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => {
      const { views } = (window as any).dragTest;
      views.closePeek();
      return (document.querySelector('.peek-card') as HTMLElement).hidden;
    }), true);
    assert.equal(await page.evaluate(async () => {
      const { views, frames, state } = (window as any).dragTest;
      await views.open(state.tabs.find((tab: any) => tab.id !== state.activeId).id, 'split');
      return [...frames.values()].some((frame: any) => frame.el.getAnimations().length > 0);
    }), false);
    // Desktop tear-off works from either split header and a peek, using the same margin as tabs.
    await page.evaluate(() => { (window as any).dragTest.popout.desktop = true; });
    for (const pane of ['a', 'b']) {
      const ids = await page.evaluate(async pane => {
        const { views, state } = (window as any).dragTest;
        views.closeSplit();
        await views.open(state.tabs.find((tab: any) => tab.id !== state.activeId).id, 'split');
        return { source: views.pageInPane(pane).id, kept: views.pageInPane(pane === 'a' ? 'b' : 'a').id };
      }, pane);
      await moveDrag(`.pane-head[data-pane="${pane}"]`, 1205, 250);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => (window as any).dragTest.popped.length), pane === 'a' ? 0 : 1);
      await moveDrag(`.pane-head[data-pane="${pane}"]`, 1240, 250);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => (window as any).dragTest.popped.at(-1).id), ids.source);
      assert.deepEqual(await page.evaluate(() => {
        const { views, state } = (window as any).dragTest;
        return { shown: [...views.shownIds()], active: state.activeId, tabs: state.tabs.length };
      }), { shown: [ids.kept], active: ids.kept, tabs: 3 });
    }
    // A Library-only peek must acquire a background tab before its child window opens.
    let openedPeek = false;
    let failPeekOpen = true;
    await page.route('**/api/tabs/library-peek/open', async route => {
      assert.deepEqual(route.request().postDataJSON(), { activate: false });
      openedPeek = true;
      if (failPeekOpen) {
        await route.fulfill({ status: 404, json: { error: 'not_found' } });
        return;
      }
      await route.fulfill({ json: { tab: { id: 'library-peek', title: 'Library peek', pinned: false } } });
    });
    await page.evaluate(async () => {
      const { views, state } = (window as any).dragTest;
      state.closed.push({ id: 'library-peek', title: 'Library peek' });
      await views.open('library-peek', 'peek');
    });
    await moveDrag('.peek-card .view-head', 1240, 250);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(openedPeek, false);
    const failedOpen = page.waitForResponse('**/api/tabs/library-peek/open');
    await moveDrag('.peek-card .view-head', 1240, 250);
    await page.mouse.up();
    await failedOpen;
    assert.equal(await page.locator('.peek-card').evaluate(el => (el as HTMLElement).hidden), false);
    assert.equal(await page.evaluate(() => (window as any).dragTest.popped.length), 2);
    failPeekOpen = false;
    await moveDrag('.peek-card .view-head', 1240, 250);
    await page.mouse.up();
    await page.waitForFunction(() => (window as any).dragTest.popped.at(-1)?.id === 'library-peek');
    assert.equal(openedPeek, true);
    assert.equal(await page.locator('.peek-card').evaluate(el => (el as HTMLElement).hidden), true);
    assert.equal(await page.evaluate(() => (window as any).dragTest.state.tabs.at(-1).id), 'library-peek');
    // Exercise the actual frame loader with a cold document whose response arrives
    // during the split animation. Loading must not pin opacity to zero until it ends.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    let releaseCold!: () => void;
    const coldResponse = new Promise<void>(resolve => { releaseCold = resolve; });
    await page.route('http://views.test/cold', async route => {
      await coldResponse;
      await route.fulfill({ contentType: 'text/html', body: '<body style="background:#234">Loaded</body>' });
    });
    await page.setContent('<main style="width:1100px;height:650px"><div id="frames"></div></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    const ensureFrameSource = appSource.slice(appSource.indexOf('  function ensureFrame('), appSource.indexOf('  /** Keep the iframe'));
    const loadFrameSource = appSource.slice(appSource.indexOf('  function loadFrame('), appSource.indexOf('  function discardFrame('));
    await page.addScriptTag({ content: `{
      const mainEl = document.querySelector('main'), framesEl = document.querySelector('#frames'), frames = new Map();
      const tabs = ['primary','cold'].map(id => ({id,title:id,revision:1}));
      const SANDBOX = 'allow-scripts', EMBED_ALLOW = '', viewUrl = tab => 'http://views.test/' + tab.id;
      const evictOverflow = () => {}, touchFrame = () => {}, cancelPageAudio = () => {};
      ${ensureFrameSource}
      ${loadFrameSource}
      const views = window.createViews({mainEl,isPageOrigin:(origin)=>origin===location.origin,
        tabs:()=>tabs,closed:()=>[],activeId:()=> 'primary',activeTab:()=>tabs[0],findAnyTab:id=>tabs.find(t=>t.id===id),
        isBlank:()=>false,draftId:()=>null,spaceId:()=> 'cold-test',spaceIds:()=>['cold-test'],
        frame:id=>frames.get(id),frameIds:()=>[...frames.keys()],ensureFrame,discardFrame:()=>{},
        markSeen:()=>{},render:()=>views.layout()
      });
      views.layout(); window.coldTest = {views,frames};
    }` });
    await page.waitForFunction(() => (window as any).coldTest.frames.get('primary').el.dataset.loaded);
    const pending = await page.evaluate(async () => {
      const { views, frames } = (window as any).coldTest;
      await views.open('cold', 'split');
      const frame = frames.get('cold').el;
      (window as any).coldFrame = frame;
      const animation = frame.getAnimations().find((a: Animation) => a.effect instanceof KeyframeEffect && a.effect.getKeyframes().some((k: ComputedKeyframe) => k.transform));
      animation.pause(); animation.currentTime = 100;
      return { opacity: getComputedStyle(frame).opacity, loading: frame.classList.contains('frame-loading') };
    });
    assert.deepEqual(pending, { opacity: '0', loading: true });
    releaseCold();
    await page.waitForFunction(() => (window as any).coldFrame.dataset.loaded);
    await page.waitForFunction(() => getComputedStyle((window as any).coldFrame).opacity === '1');
    assert.equal(await page.evaluate(() => {
      const { views, frames } = (window as any).coldTest;
      const frame = frames.get('cold').el;
      const transformStillRunning = frame.getAnimations().some((a: Animation) => a.playState === 'paused');
      views.layout();
      return transformStillRunning && frame === (window as any).coldFrame && getComputedStyle(frame).opacity === '1';
    }), true);
    // Use the real draft creation and frame rendering together: splitting the
    // active tab must never render the new draft at full width.
    await page.route('http://views.test/api/drafts', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ tab: { id: 'draft', title: 'New page', draft: true } }),
    }));
    await page.setContent('<main style="width:1100px;height:650px"><div id="frames"></div><div id="empty"></div><div id="newpage" class="newpage" hidden></div></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    const newPageSource = appSource.slice(appSource.indexOf('  async function newPage('), appSource.indexOf('  /**\n   * Leaving a draft'));
    const renderFramesSource = appSource.slice(appSource.indexOf('  function renderFrames('), appSource.indexOf('  function endPageIntent('));
    await page.addScriptTag({ content: `{
      const mainEl = document.querySelector('main'), newPageEl = document.querySelector('#newpage'), emptyEl = document.querySelector('#empty');
      const tabs = [{id:'original',title:'Original'}], frames = new Map();
      const state = {activeId:'original',draft:null,restored:true};
      const childId = null, popoutTitle = null, pageIntent = null, pageHint = null, pageHintEl = document.createElement('div');
      let pendingFocus = null, lastInteractedAt = 0;
      const activeTab = () => state.draft?.id === state.activeId ? state.draft : tabs[0];
      const draftActive = () => activeTab()?.draft, isBlank = tab => !!tab?.draft;
      const syncHash = () => {}, reportViewer = () => {}, showNotice = () => {}, checkPageAudioVisibility = () => {};
      const draftWidths = [];
      const newPageView = {
        focus(){}, replace(){newPageEl.hidden=true;},
        show(item){newPageEl.hidden=!item;if(item){newPageEl.dataset.pane=item.pane;if(!item.pane)delete newPageEl.dataset.pane;draftWidths.push(newPageEl.getBoundingClientRect().width);}}
      };
      const render = () => renderFrames();
      ${newPageSource}
      ${renderFramesSource}
      const views = window.createViews({mainEl,isPageOrigin:(origin)=>origin===location.origin,
        tabs:()=>tabs,closed:()=>[],activeId:()=>state.activeId,activeTab,
        findAnyTab:id=>tabs.find(tab=>tab.id===id) || (state.draft?.id===id ? state.draft : null),
        isBlank,draftId:()=>state.draft?.id,spaceId:()=> 'active-split-test',spaceIds:()=>['active-split-test'],
        frame:id=>frames.get(id),frameIds:()=>[...frames.keys()],ensureFrame:meta=>{
          if(!frames.has(meta.id)){const el=document.createElement('iframe');document.querySelector('#frames').append(el);frames.set(meta.id,{el});}
          return frames.get(meta.id);
        },discardFrame:()=>{},markSeen:()=>{},render,newPage
      });
      render(); window.activeSplitTest = {views,frames,draftWidths};
    }` });
    const activeMotion = await page.evaluate(async () => {
      const { views, frames, draftWidths } = (window as any).activeSplitTest;
      const original = frames.get('original').el;
      const originalWidth = original.getBoundingClientRect().width;
      await views.open('original', 'split');
      const draft = document.querySelector('#newpage')!;
      const animations = [original, draft].map(node => node.getAnimations()[0]);
      for (const animation of animations) animation.pause();
      const samples = [0, 120, 240].map(time => {
        for (const animation of animations) animation.currentTime = time;
        return [original.getBoundingClientRect().width, draft.getBoundingClientRect().width];
      });
      const openingDraftWidths = [...draftWidths];
      views.closeSplit();
      await Promise.resolve();
      const closing = draft.getAnimations()[0];
      closing.pause();
      const closeWidths = [0, 120, 240].map(time => {
        closing.currentTime = time;
        return draft.getBoundingClientRect().width;
      });
      return { originalWidth, draftWidths: openingDraftWidths, samples, closeWidths, originalKept: frames.get('original').el === original };
    });
    assert.ok(activeMotion.draftWidths.length > 0);
    assert.ok(activeMotion.draftWidths.every((width: number) => Math.abs(width - 550) < 1));
    assert.ok(activeMotion.samples.every((sample: number[]) => Math.abs(sample[1] - 550) < 1));
    assert.ok(activeMotion.samples.every((sample: number[]) => Math.abs(sample[0] - 550) < 1));
    assert.ok(Math.abs(activeMotion.samples[2][0] - 550) < 1);
    assert.equal(activeMotion.originalKept, true);
    assert.ok(activeMotion.closeWidths.every((width: number) => Math.abs(width - activeMotion.originalWidth) < 1));
    assert.ok(Math.abs(activeMotion.closeWidths[2] - activeMotion.originalWidth) < 1);
  } finally {
    await browser.close();
  }
});

test("a split holds more than two panes: stored two-pane splits migrate, drops add panes, links replace the next one", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Page views panes test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route("http://views.test/**", route => route.fulfill({ contentType: "text/html", body: '<main style="width:1100px;height:700px"></main>' }));
    await page.goto("http://views.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") + "\nmain {position:relative} iframe {position:absolute}" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/pointer-drag.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/motion.js", import.meta.url), "utf8") });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/views.js", import.meta.url), "utf8") });
    const result = await page.evaluate(async () => {
      const w = window as any;
      const mainEl = document.querySelector("main")!;
      const pages = new Map(["a", "b", "c", "d", "e"].map(id => [id, { id, title: id }]));
      const frames = new Map<string, { el: HTMLIFrameElement }>();
      let active: string | null = "a";
      let views: any;
      const select = (id: string) => { views.onSelect(id); active = id; views.layout(); };
      const host = {
        mainEl, isPageOrigin: (origin: string) => origin === location.origin,
        tabs: () => [...pages.values()], closed: () => [],
        findAnyTab: (id: string) => pages.get(id) || null,
        activeId: () => active, activeTab: () => pages.get(active!) || null,
        isBlank: () => false, draftId: () => null, activate: select,
        spaceId: () => "s", spaceIds: () => ["s"],
        frame: (id: string) => frames.get(id), frameIds: () => [...frames.keys()],
        ensureFrame: (meta: any) => {
          if (!frames.has(meta.id)) {
            const el = document.createElement("iframe");
            mainEl.append(el);
            frames.set(meta.id, { el });
          }
          return frames.get(meta.id);
        },
        discardFrame: (id: string) => { frames.get(id)?.el.remove(); frames.delete(id); },
        selectTab: select, openPage: select, showNotice: () => {}, linkMode: () => "tab",
        markSeen: () => {}, render: () => views.layout(),
      };
      const stored = () => JSON.parse(localStorage.getItem("scribe.spaceSplits") || "{}").s;
      const panes = () => ["a", "b", "c", "d"].map(pane => [...frames].find(([, f]) => f.el.dataset.pane === pane && !f.el.classList.contains("inactive"))?.[0] || "").join("");
      const focused = () => (mainEl.querySelector(".pane-head.focused") as HTMLElement)?.dataset.pane;
      const dividers = () => [...mainEl.querySelectorAll(".split-divider")].filter(el => !(el as HTMLElement).hidden) as HTMLElement[];
      const widths = () => [...mainEl.querySelectorAll(".pane-head")].filter(el => !(el as HTMLElement).hidden).map(el => Math.round(el.getBoundingClientRect().width));
      const box = mainEl.getBoundingClientRect();
      const drag = async (source: any, x: number, y: number) => {
        views.beginPageDrag(source);
        const drop = views.updatePageDrag(box.left + box.width * x, box.top + box.height * y);
        views.endPageDrag();
        await views.dropPage(source, drop);
        return drop;
      };
      const observations: Record<string, unknown> = {};
      // A split stored before panes were a list: the other pane, the focused one's side, the tab it showed.
      localStorage.setItem("scribe.spaceSplits", JSON.stringify({ s: { page: "b", ratio: 0.4, dir: "row", side: 1, seen: "a" } }));
      views = w.createViews(host); views.prune(); views.layout();
      observations.migrated = [panes(), focused(), widths()];
      // A tab dropped towards an edge along the split becomes a pane beside the one under the pointer.
      observations.addDrop = await drag({ id: "c" }, 0.97, 0.3);
      observations.added = [panes(), focused(), dividers().length, widths(), stored()];
      // A split link shows in the pane after the focused one, or before it from the last pane.
      await views.open("d", "split");
      observations.linkNext = [panes(), focused()];
      select("d");
      await views.open("c", "split");
      observations.linkFromLast = [panes(), focused()];
      // 1100px has no room for a fourth pane: the tab takes the place of the pane under it.
      observations.fullDrop = await drag({ id: "a" }, 0.03, 0.3);
      observations.full = [panes(), focused()];
      // A pane dragged by its header moves with its size; a drop that changes nothing is no drop.
      observations.noMove = await drag({ pane: "a" }, 0.03, 0.3);
      observations.moveDrop = await drag({ pane: "a" }, 0.97, 0.3);
      observations.moved = [panes(), focused(), widths()];
      // Each divider swaps its own two panes, and sizes only them.
      (dividers()[0].querySelector('[aria-label="Swap panes"]') as HTMLButtonElement).click();
      observations.swapped = [panes(), focused()];
      dividers()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true }));
      observations.resized = widths();
      dividers()[1].dispatchEvent(new MouseEvent("dblclick"));
      observations.evened = widths();
      // Towards an edge across the split turns all of it.
      observations.turnDrop = await drag({ pane: "c" }, 0.5, 0.02);
      observations.turned = [panes(), mainEl.classList.contains("split-col")];
      (dividers()[0].querySelector('[aria-label="Show side by side"]') as HTMLButtonElement).click();
      // Closing the focused pane hands focus to the next pane; the split stays while two are left.
      const before = [panes(), focused(), active];
      (mainEl.querySelector(`.pane-head[data-pane="${focused()}"] [aria-label="Close pane"]`) as HTMLButtonElement).click();
      observations.closedFocused = [before, panes(), focused(), active];
      await views.open("e", "split");
      await drag({ id: "b" }, 0.03, 0.3);
      observations.three = panes();
      // A closed or deleted tab takes only its own pane.
      const gone = panes()[0];
      views.onClosed(gone); pages.delete(gone); views.layout();
      observations.tabClosed = [panes().length, mainEl.classList.contains("has-split")];
      views = w.createViews(host); views.prune(); views.layout();
      observations.reloaded = [panes().length, stored().panes.length, stored().sizes.reduce((sum: number, size: number) => sum + size, 0).toFixed(3)];
      return observations;
    });
    assert.ok(Array.isArray(result.added));
    const addedLayout = result.added[4] as { sizes: number[] };
    assert.deepEqual(result, {
      migrated: ["ba", "b", [440, 660]],
      addDrop: { edge: "right", at: 1 },
      added: ["bac", "b", 2, [293, 440, 367], { panes: [{ page: "b" }, { page: "a" }, { page: "c" }], sizes: addedLayout.sizes, dir: "row", focus: 1 }],
      linkNext: ["bad", "b"], linkFromLast: ["bcd", "c"],
      fullDrop: { pane: "a" }, full: ["acd", "c"],
      noMove: null, moveDrop: { edge: "right", at: 2 }, moved: ["cda", "b", [440, 367, 293]],
      swapped: ["dca", "a"], resized: [367, 330, 403], evened: [367, 367, 367],
      turnDrop: { edge: "top" }, turned: ["adc", true],
      closedFocused: [["adc", "b", "d"], "ac", "b", "c"],
      three: "bec", tabClosed: [2, true], reloaded: [2, 2, "1.000"],
    });
  } finally {
    await browser.close();
  }
});
