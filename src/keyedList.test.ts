import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { loadChatFixture } from "./testSupport/shell.js";

test("scribeKeyedList keeps elements by key, moves only what is out of order, and leaves other classes alone", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Keyed list test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<ul id="list"><li class="stray">left over</li></ul>');
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/dom-sync.js", import.meta.url), "utf8") });
    // A plain script: helpers declared inside evaluate() do not survive the test runner's transform.
    await page.addScriptTag({ content: `
      window.check = () => {
        const list = document.querySelector("#list");
        let created = 0;
        const items = (rows) => rows.map(([key, status]) => ({
          key,
          create: () => { created++; const li = document.createElement("li"); li.dataset.key = key; return li; },
          update: (li) => {
            scribeClasses(li, { running: status === "running" });
            scribeAttr(li, "data-status", status);
            scribeFill(li, key + status, () => [document.createTextNode(key + " " + status)]);
          },
        }));
        scribeKeyedList(list, items([["a", "idle"], ["b", "idle"], ["c", "idle"], ["d", "idle"], ["e", "idle"]]));
        const before = [...list.children];
        before[1].classList.add("menu-on");
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true });
        // a moves to the end, c starts running, d goes, f is new.
        scribeKeyedList(list, items([["b", "idle"], ["c", "running"], ["e", "idle"], ["f", "idle"], ["a", "idle"]]));
        const records = observer.takeRecords();
        const moved = records.flatMap((r) => [...r.addedNodes]).map((n) => n.dataset.key);
        const after = [...list.children];
        return {
          order: after.map((li) => li.textContent),
          kept: [after[0] === before[1], after[1] === before[2], after[2] === before[4], after[4] === before[0]],
          created,
          moved,
          classes: [after[0].className, after[1].className, after[1].dataset.status],
          duplicate: (scribeKeyedList(list, items([["a", "idle"], ["a", "idle"]])), list.children.length),
        };
      };
    ` });
    assert.deepEqual(await page.evaluate(() => (window as any).check()), {
      order: ["b idle", "c running", "e idle", "f idle", "a idle"],
      kept: [true, true, true, true],
      created: 6,
      moved: ["a", "f"],
      classes: ["menu-on", "running", "running"],
      duplicate: 2,
    });
  } finally {
    await browser.close();
  }
});

test("Trash rows are kept by key when the Trash reloads and a folder opens (#430)", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Trash keyed rows test" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<span id="trash-count"></span><button id="trash-empty"></button><div id="trash-none"></div><div id="trash-list"></div>');
    for (const file of ["dom-sync.js", "trash.js"]) {
      await page.addScriptTag({ content: fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8") });
    }
    // A plain script: async helpers inside evaluate() are rewritten by the test runner's transform.
    await page.addScriptTag({ content: `
      const now = Date.now();
      window.batches = [{ id: "b1", deletedAt: now, expiresAt: now + 864e5 * 7,
        folders: [{ id: "f", name: "Folder", pos: 0 }],
        tabs: [{ id: "p", title: "Page", libPos: 0 }, { id: "q", title: "Inside", folderId: "f", libPos: 0 }] }];
      window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ batches: window.batches }) });
      window.trash = createTrash({ icons: { file: "", folder: "", chevron: "" }, closeMenu() {} });
      trash.setVisible(true);
    ` });
    await page.waitForSelector("#trash-list .lib-row");
    const held = await page.evaluateHandle(() => [...document.querySelectorAll("#trash-list .lib-row")]);
    await page.evaluate(() => {
      const w = window as any;
      w.batches[0].tabs[0].title = "Page renamed";
      w.trash.refresh();
    });
    await page.waitForFunction(() => document.querySelector('#trash-list [data-id="p"] .tab-title')?.textContent === "Page renamed");
    await page.locator('#trash-list .lib-row[data-id="f"]').press("ArrowRight");
    assert.deepEqual(await page.evaluate((before) => {
      const rows = [...document.querySelectorAll("#trash-list .lib-row")] as HTMLElement[];
      return [rows.map(row => row.dataset.id), rows[0] === before[0], rows[2] === before[1], rows[0].getAttribute("aria-expanded"),
        rows[1].getAttribute("aria-level"), rows[2].querySelector(".tab-title")!.textContent];
    }, held), [["f", "q", "p"], true, true, "true", "2", "Page renamed"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Palette rows are kept by key as the hits change, and hover and clicks read the row's current hit (#929)", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Palette keyed rows test" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="palette-list" style="max-height:400px;overflow:auto"></div><div id="palette-empty"></div>');
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/dom-sync.js", import.meta.url), "utf8") });
    const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: `
      const paletteList = document.querySelector("#palette-list"), paletteEmpty = document.querySelector("#palette-empty");
      let paletteHits = [], paletteIndex = 0, paletteKind = "pages", semanticProgress = "";
      const paletteQuery = () => ({ id: "pages", query: "x" });
      const library = { pathOf: (id) => "Folder " + id };
      const views = { modeFromEvent: () => null };
      const activatePaletteHit = (tab) => { window.opened = tab.title; };
      ${app.slice(app.indexOf("  function renderPalette("), app.indexOf("  function movePalette("))}
      window.show = (hits, index = 0) => { paletteHits = hits; paletteIndex = index; renderPalette(); };
      window.index = () => paletteIndex;
    ` });
    await page.evaluate(() => (window as any).show([
      { id: "a", title: "Alpha", open: true },
      { id: "b", title: "Beta", open: false, folderId: "f" },
      { id: "c", title: "Gamma", open: true, section: "Related" },
    ]));
    const held = await page.evaluateHandle(() => [...document.querySelectorAll("#palette-list > *")]);
    // The next keystroke drops Alpha, renames Beta and moves Gamma above it.
    await page.evaluate(() => (window as any).show([
      { id: "c", title: "Gamma", open: true, section: "Related" },
      { id: "b", title: "Beta 2", open: false, folderId: "f" },
    ], 1));
    assert.deepEqual(await page.evaluate((before) => {
      const nodes = [...document.querySelectorAll("#palette-list > *")];
      return [nodes.length, nodes[0] === before[2], nodes[1] === before[3], nodes[2] === before[1],
        nodes.map((n) => n.textContent), nodes[2].classList.contains("active"), (window as any).index()];
    }, held), [3, true, true, true, ["Related", "Gamma", "Beta 2ClosedFolder f"], true, 1]);
    await page.locator('#palette-list .palette-row').nth(0).hover();
    assert.equal(await page.evaluate(() => (window as any).index()), 0);
    await page.locator('#palette-list .palette-row').nth(1).click();
    assert.equal(await page.evaluate(() => (window as any).opened), "Beta 2");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Chat thread list rows are kept by key as threads change, and pick through the latest render (#929)", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Thread list keyed rows test" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.route("http://threads.test/**", route => route.fulfill({ contentType: "text/html", body: '<div id="threads"></div>' }));
    await page.goto("http://threads.test/");
    const agent = fs.readFileSync(new URL("../public/agent.js", import.meta.url), "utf8");
    await loadChatFixture(page, agent.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, `
      S.filter = 'all';
      const now = Date.now();
      const thread = (id, title, extra = {}) => ({ id, title, provider: 'claude', model: 'm', status: 'idle', scope: { kind: 'global' },
        stats: { turns: 1, files: 0 }, activityAt: now, createdAt: now, updatedAt: now, ...extra });
      for (const t of [thread('a', 'Alpha'), thread('b', 'Beta', { activityAt: now - 1000 })]) S.threads.set(t.id, t);
      window.render = (tag) => renderThreadList(document.querySelector('#threads'), { onPick: (id) => { window.picked = tag + ':' + id; }, currentId: 'a' });
      window.change = () => {
        S.threads.set('b', { ...S.threads.get('b'), status: 'running', title: 'Beta running' });
        S.threads.set('c', thread('c', 'Gamma', { activityAt: now - 2000 }));
      };
    `));
    await page.evaluate(() => (window as any).render("first"));
    const held = await page.evaluateHandle(() => [...document.querySelectorAll("#threads .ag-row-wrap")]);
    await page.evaluate(() => { (window as any).change(); (window as any).render("second"); });
    assert.deepEqual(await page.evaluate((before) => {
      const rows = [...document.querySelectorAll("#threads .ag-row-wrap")];
      const b = rows.find((row) => row.querySelector('[data-id="b"]'))!;
      const button = b.querySelector("button.ag-row")!;
      return [rows.length, rows.includes(before[0]), b === before[1], button.classList.contains("s-running"),
        button.querySelector(".ag-row-title")!.textContent];
    }, held), [3, true, true, true, "Beta running"]);
    await page.locator('#threads button.ag-row[data-id="b"]').click();
    assert.equal(await page.evaluate(() => (window as any).picked), "second:b");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
