import { templateHtml } from "./testSupport/templates.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("Kanban columns load batches independently and retain them through live updates", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban lazy loading test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = templateHtml("kanban");
    await page.setContent(`<script>
      window.scribe = {
        state: {
          columns: [{ id: 'todo', title: 'Todo' }, { id: 'other', title: 'Other' }],
          labels: [], nextNum: 77, settings: { workers: { sol: { name: 'Sol', color: '#a78bfa' } } },
          cards: Array.from({ length: 76 }, (_, i) => ({ id: 'c' + (i + 1), num: i + 1,
            col: i < 55 ? 'todo' : 'other', title: 'Task ' + (i + 1), labels: [], priority: 0,
            ...(i === 0 ? { createdBy: 'Sol', createdThread: 'th_creator', thread: 'th_assignee' } : {}),
            ...(i === 1 ? { createdBy: 'user' } : {}) }))
        }, local: {}, title: 'Project board', template: { values: { agentMode: false } },
        onTitle(fn) { this.titleChanged = fn; },
        setTitle(title) { this.title = title; this.titleChanged(); return Promise.resolve({ ok: true }); },
        set(patch) { this.state = { ...this.state, ...patch }; this.wrote(); },
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; },
        // Like the bridge: the board hears its own writes once the writing code has finished.
        wrote() { queueMicrotask(() => this.changed && this.changed(this.state, { source: 'local', ops: null })); },
        agent: { show(id, options) { window.openedCreator = { id, options }; return Promise.resolve({ ok: true }); } }
      };
    </script>${html}`);
    const title = page.locator('#boardTitle');
    assert.equal(await title.innerText(), 'Project board');
    assert.equal(await page.locator('#workersBtn').isVisible(), true);
    await title.click();
    await page.keyboard.type('Renamed / board');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window as any).scribe.title), 'Renamed / board');
    await title.focus();
    await page.keyboard.press('F2');
    await page.keyboard.type('Discarded');
    await page.keyboard.press('Escape');
    assert.equal(await title.innerText(), 'Renamed / board');
    await title.click();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.equal(await title.innerText(), 'Renamed / board');
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.title = 'Renamed in Library';
      scribe.titleChanged();
    });
    assert.equal(await title.innerText(), 'Renamed in Library');
    const todo = page.locator('.cards[data-col="todo"]');
    const other = page.locator('.cards[data-col="other"]');
    const waitCount = async (col: string, count: number) => {
      await page.waitForFunction(({ col, count }) => document.querySelectorAll(`.cards[data-col="${col}"] .card`).length === count, { col, count });
    };
    assert.equal(await todo.locator('.card').count(), 20);
    assert.equal(await other.locator('.card').count(), 20);
    assert.equal(await page.locator('.card .card-creator').count(), 0);
    await todo.locator('[data-id="c1"] .card-title').click();
    assert.equal(await page.locator('#mTimes .card-creator').innerText(), 'Created by Sol');
    assert.equal(await page.locator('#mTimes .card-creator span').evaluate(node => getComputedStyle(node).color), 'rgb(167, 139, 250)');
    await page.locator('#mTimes .card-creator').click();
    assert.deepEqual(await page.evaluate(() => (window as any).openedCreator), { id: 'th_creator', options: { where: 'sidebar' } });
    await page.keyboard.press('Escape');
    await todo.locator('[data-id="c2"] .card-title').click();
    assert.equal(await page.locator('#mTimes .card-creator').innerText(), 'Created by you');
    await page.keyboard.press('Escape');
    await todo.locator('[data-id="c3"] .card-title').click();
    assert.equal(await page.locator('#mTimes .card-creator').innerText(), 'Created by unknown');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.column[data-col="todo"] .col-count').innerText(), '55');
    assert.equal(await todo.locator('[data-id="c21"]').count(), 0);
    const first = await todo.locator('.card').first().elementHandle();
    await todo.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 200; });
    await waitCount('todo', 40);
    assert.equal(await first!.evaluate(node => node.isConnected), true);
    assert.equal(await other.locator('.card').count(), 20);
    await todo.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await waitCount('todo', 55);
    const scroll = await todo.evaluate(node => node.scrollTop);
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.cards[54] = { ...scribe.state.cards[54], title: 'Updated last task' };
      scribe.changed();
    });
    await todo.getByText('Updated last task', { exact: true }).waitFor();
    assert.equal(await todo.locator('.card').count(), 55);
    assert.equal(await todo.evaluate(node => node.scrollTop), scroll);
    await page.locator('#search').fill('Updated last task');
    await waitCount('todo', 1);
    assert.equal(await todo.locator('.card').getAttribute('data-id'), 'c55');
    await page.locator('#search').fill('');
    await waitCount('todo', 20);
    assert.equal(await todo.evaluate(node => node.scrollTop), 0);
    await other.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await waitCount('other', 21);
    assert.equal(await page.evaluate(() => (window as any).scribe.state.cards.length), 76);
    // Holding a dragged card at the lower edge must load the remaining cards too.
    const cardBox = (await todo.locator('.card').first().boundingBox())!;
    const listBox = (await todo.boundingBox())!;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2, listBox.y + listBox.height + 10, { steps: 10 });
    await waitCount('todo', 55);
    await page.waitForFunction(() => {
      const list = document.querySelector('.cards[data-col="todo"]')!;
      return list.scrollHeight - list.scrollTop - list.clientHeight < 2;
    });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const cards = (window as any).scribe.state.cards.filter((c: any) => c.col === 'todo');
      return cards[cards.length - 1].id === 'c1';
    });
    await page.locator('.column[data-col="todo"] .add-card').click();
    await page.locator('.composer-input').fill('New task at top');
    await page.locator('.composer-input').press('Enter');
    await todo.getByText('New task at top', { exact: true }).waitFor();
    // New cards go to the top; the column keeps its loaded batch size.
    assert.equal(await todo.locator('.card').first().getByText('New task at top', { exact: true }).count(), 1);
    assert.equal(await page.locator('.column[data-col="todo"] .col-count').innerText(), '56');
    assert.equal(await todo.locator('.card').count(), 55);
    // The dragged card is now just beyond the retained batch, not lost or awaiting a paint.
    assert.equal(await todo.locator('[data-id="c1"]').count(), 0);
    const expectedIds = await page.evaluate(() => (window as any).scribe.state.cards
      .filter((c: any) => c.col === 'todo').map((c: any) => c.id));
    assert.equal(expectedIds.length, 56);
    assert.equal(expectedIds.at(-1), 'c1');
    await todo.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await waitCount('todo', 56);
    assert.deepEqual(await todo.locator('.card').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id)), expectedIds);
    assert.equal(await other.locator('.card').count(), 21);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Board header shows main provider quotas, detailed tips, and live recovery", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban usage test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = templateHtml("kanban");
    await page.setContent(`<script>
      window.scribe = {
        state: { columns: [{ id: 'todo', title: 'Ready', role: 'agent' }], labels: [], cards: [], nextNum: 1,
          settings: { workers: { a: { name: 'Sol', provider: 'codex' }, b: { name: 'Luna', provider: 'pi' } } } },
        local: {}, set(patch) { this.state = { ...this.state, ...patch }; this.wrote(); }, setLocal(patch) { Object.assign(this.local, patch); },
        update(ops) {
          for (const op of ops) if (op.path === 'settings/workerOrder') this.state = { ...this.state, settings: { ...this.state.settings, workerOrder: op.value } };
          this.wrote();
        },
        onChange(fn) { this.changed = fn; },
        // Like the bridge: the board hears its own writes once the writing code has finished.
        wrote() { queueMicrotask(() => this.changed && this.changed(this.state, { source: 'local', ops: null })); },
        agent: {
          options() { return Promise.resolve({ ok: true, providers: ['codex', 'claude', 'cursor'].map(id => ({ id, available: true })), models: {} }); },
          limits() { return Promise.resolve({ ok: true, limits: { codex: { at: Date.now(), ordinaryUsageAllowed: false,
            windows: [{ id: 'codex:codex:primary', label: '5-hour', utilization: 1, resetsAt: Date.now() - 1000 },
              { id: 'codex:codex:secondary', label: 'Weekly', utilization: 0.5 }] },
            claude: { at: Date.now(), windows: [{ id: 'five_hour', label: '5-hour', utilization: 0.75, resetsAt: Date.now() - 1000 },
              { id: 'seven_day', label: 'Weekly', utilization: 0.95 }] },
            cursor: { at: Date.now(), windows: [{ id: 'cursor_included', label: 'Included', utilization: 0.91 },
              { id: 'cursor_auto', label: 'Auto', utilization: 0.3 }, { id: 'cursor_api', label: 'API', utilization: 0.8 }] }
          } }); },
          onLimits(fn) { this.changedLimits = fn; }, threads() { return Promise.resolve({ ok: true, threads: [] }); }
        }
      };
    </script>${html}`);
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/tooltip.js', import.meta.url), 'utf8') });
    const usage = page.getByRole('region', { name: 'Usage limits' });
    const codex = usage.locator('[data-provider="codex"]');
    const claude = usage.locator('[data-provider="claude"]');
    const cursor = usage.locator('[data-provider="cursor"]');
    await codex.getByText('100%').waitFor();
    assert.match(await codex.getAttribute('data-tooltip') || '', /Reset passed · awaiting update/);
    assert.match(await codex.getAttribute('data-tooltip') || '', /Included usage blocked/);
    assert.equal(await usage.locator('[data-provider="pi"]').count(), 0);
    assert.equal(await codex.locator('progress').getAttribute('value'), '100');
    assert.equal(await claude.locator('progress').getAttribute('value'), '0');
    assert.match(await claude.getAttribute('data-tooltip') || '', /Reset passed/);
    assert.doesNotMatch(await claude.getAttribute('data-tooltip') || '', /awaiting update/);
    assert.equal(await cursor.locator('progress').getAttribute('value'), '91');
    assert.doesNotMatch(await claude.getAttribute('class') || '', /lvl-warn/);
    assert.match(await cursor.getAttribute('class') || '', /lvl-high/);
    const headerBounds = (await usage.boundingBox())!;
    const actionBounds = (await page.locator('#workersBtn').boundingBox())!;
    assert.ok(headerBounds.y + headerBounds.height < actionBounds.y);
    assert.ok(headerBounds.x + headerBounds.width > actionBounds.x);
    await cursor.hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor({ state: 'visible' });
    assert.match(await tip.innerText(), /Included: 91% used/);
    assert.match(await tip.innerText(), /Auto: 30% used/);
    assert.match(await tip.innerText(), /API: 80% used/);
    assert.deepEqual(await tip.locator('progress').evaluateAll(bars => bars.map(bar => (bar as HTMLProgressElement).value)), [91, 30, 80]);
    assert.deepEqual(await tip.locator('.scribe-tooltip-quota').evaluateAll(rows => rows.map(row => (row as HTMLElement).style.getPropertyValue('--quota-color'))),
      ['var(--danger, #ef8585)', 'var(--ag-ok, #8fd19e)', 'var(--ag-warn, #e8c47a)']);
    await codex.focus();
    await tip.getByText(/Weekly: 50% used/).waitFor();
    await page.locator('#workersBtn').click();
    assert.equal(await page.locator('#workersPop .board-quota').count(), 0);
    const workerNames = () => page.locator('#workersPop .wrow .nm').allTextContents();
    assert.deepEqual(await workerNames(), ['Sol', 'Luna']);
    assert.equal(await page.getByRole('button', { name: 'Move Sol up', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Move Luna up', exact: true }).click();
    assert.deepEqual(await workerNames(), ['Luna', 'Sol']);
    assert.equal(await page.locator('#workersPop .wedit').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).scribe.state.settings.workerOrder), ['b', 'a']);
    await page.locator('#workersBtn').click();
    await page.locator('#workersBtn').click();
    assert.deepEqual(await workerNames(), ['Luna', 'Sol']);
    await page.getByRole('button', { name: 'Move Luna down', exact: true }).click();
    assert.deepEqual(await workerNames(), ['Sol', 'Luna']);
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.settings.workerOrder = ['missing', 'b', 'b'];
      scribe.state.settings.workers.c = { name: 'New worker', color: '#ffffff' };
      scribe.changed();
    });
    // State changes queue a render; wait for the rows rather than reading the previous frame.
    await page.waitForFunction(expected => {
      const names = [...document.querySelectorAll('#workersPop .wrow .nm')].map(node => node.textContent);
      return JSON.stringify(names) === JSON.stringify(expected);
    }, ['Luna', 'Sol', 'New worker']);
    assert.deepEqual(await workerNames(), ['Luna', 'Sol', 'New worker']);
    await page.evaluate(() => (window as any).scribe.agent.changedLimits({ codex: { at: Date.now(), ordinaryUsageAllowed: true,
      windows: [{ id: 'codex:codex:primary', label: '5-hour', utilization: 0.25, resetsAt: Date.now() + 3600000 }] } }));
    await codex.getByText('25%').waitFor();
    assert.doesNotMatch(await codex.getAttribute('data-tooltip') || '', /Included usage blocked|awaiting update/);
    assert.equal(await codex.locator('progress').getAttribute('value'), '25');
    assert.match(await codex.getAttribute('class') || '', /lvl-ok/);
    await page.setViewportSize({ width: 520, height: 900 });
    assert.ok(await usage.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    await page.evaluate(() => (window as any).scribe.agent.changedLimits({
      codex: { availability: 'unavailable', windows: [] },
      claude: { windows: [] },
      cursor: { windows: [{ id: 'cursor_included', utilization: null }] },
    }));
    assert.equal(await usage.locator('.board-quota').count(), 0);
    assert.equal(await usage.isVisible(), false);
    await page.evaluate(() => (window as any).scribe.agent.changedLimits({
      claude: { at: Date.now(), windows: [{ id: 'five_hour', label: '5-hour', utilization: 0 }] },
    }));
    await claude.getByText('0%').waitFor();
    assert.equal(await usage.locator('.board-quota').count(), 1);
    assert.equal(await claude.locator('progress').getAttribute('value'), '0');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Kanban filters cycle, combine includes, and give exclusions precedence", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban filter test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = templateHtml("kanban");
    await page.setContent(`<script>
      window.scribe = {
        state: {
          columns: [{ id: 'todo', title: 'Todo' }],
          labels: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
          nextNum: 5, settings: {},
          cards: [
            { id: '1', num: 1, col: 'todo', title: 'One', labels: ['a'], priority: 3, assignee: 'Sol' },
            { id: '2', num: 2, col: 'todo', title: 'Two', labels: ['b'], priority: 0, assignee: 'Luna' },
            { id: '3', num: 3, col: 'todo', title: 'Three', labels: ['a', 'b'], priority: 3, assignee: 'sol' },
            { id: '4', num: 4, col: 'todo', title: 'Four', labels: [], priority: 1, assignee: '' }
          ]
        },
        local: {},
        set(patch) { this.state = { ...this.state, ...patch }; this.wrote(); },
        setLocal(patch) { Object.assign(this.local, patch); },
        onChange(fn) { this.changed = fn; },
        // Like the bridge: the board hears its own writes once the writing code has finished.
        wrote() { queueMicrotask(() => this.changed && this.changed(this.state, { source: 'local', ops: null })); }
      };
    </script>${html}`);
    const shown = () => page.locator(".cards .card").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.id).sort());
    const filter = (id: string) => page.locator(`#${id}`).locator("xpath=preceding-sibling::button[1]");
    const option = (name: string) => page.getByRole("option", { name, exact: true });
    const clear = () => page.locator("#clearFilter").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);

    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any, i: number) => ({ ...c,
        comments: [{ id: 'cm' + i, by: i === 3 ? 'user' : 'Sol', at: 100, text: 'Update' }],
        seenAt: i === 1 ? 100 : 0
      }));
      scribe.changed();
    });
    await filter("fUpdates").click();
    await option("Unread updates").click();
    assert.deepEqual(await shown(), ["1", "3"]);
    assert.equal(await page.locator("#meta").innerText(), "2 of 4 cards");
    await filter("fLabel").click();
    await option("Beta: off").click();
    assert.deepEqual(await shown(), ["3"]);
    await clear();
    await filter("fUpdates").click();
    await option("Read updates").click();
    assert.deepEqual(await shown(), ["2", "4"]);
    await filter("fUpdates").click();
    await option("Unread updates").click();
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any) => c.id === '1' ? { ...c, seenAt: 100 } : c);
      scribe.changed();
    });
    await page.waitForFunction(() => document.querySelectorAll('.cards .card').length === 1);
    assert.deepEqual(await shown(), ["3"]);
    await clear();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await filter("fUpdates").innerText(), "Any updates");

    // Worker updates must leave every unchanged open option connected and hovered.
    for (const [id, name] of [["fLabel", "Alpha: off"], ["fPriority", "High: off"], ["fAssignee", "Sol: off"]]) {
      await filter(id).click();
      await option(name).hover();
      assert.deepEqual(await page.evaluate(() => {
        const scribe = (window as any).scribe;
        const rows = [...document.querySelectorAll('.select-list button[role="option"]')];
        const hovered = rows.find(row => row.classList.contains("active"))!;
        const observer = new MutationObserver(() => {});
        observer.observe(document.querySelector(".select-list")!, { childList: true, subtree: true });
        for (let i = 0; i < 5; i++) {
          scribe.state.settings.workerLog = [{ text: "Worker update " + i }];
          scribe.state.cards[1] = { ...scribe.state.cards[1], status: { kind: "working", text: "Working " + i } };
          scribe.changed();
        }
        const removed = observer.takeRecords().flatMap(record => [...record.removedNodes]);
        observer.disconnect();
        return [rows.every(row => row.isConnected), hovered.classList.contains("active"),
          removed.every(node => rows.every(row => node !== row && !node.contains(row)))];
      }), [true, true, true]);
      await page.keyboard.press("Escape");
    }

    await filter("fLabel").click();
    await option("Alpha: off").click();
    assert.deepEqual(await shown(), ["1", "3"]);
    assert.equal(await page.getByRole("listbox").isVisible(), true);
    await option("Beta: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3"]);
    await option("Beta: included").click();
    assert.deepEqual(await shown(), ["1"]); // Both labels: exclusion wins.
    await option("Alpha: included").click();
    assert.deepEqual(await shown(), ["4"]); // Negative-only filters start with all cards.
    await option("Beta: excluded").click();
    assert.deepEqual(await shown(), ["2", "4"]);
    await option("Alpha: excluded").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.locator("#clearFilter").isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("listbox").count(), 0);

    await filter("fPriority").click();
    await option("None: off").click();
    assert.deepEqual(await shown(), ["2"]); // Priority zero is a real selection.
    await option("High: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3"]);
    await option("High: included").click();
    assert.deepEqual(await shown(), ["2"]);
    await option("Any priority: off").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.getByRole("listbox").isVisible(), true);
    await page.keyboard.press("Escape");

    await filter("fAssignee").click();
    await option("Sol: off").click();
    assert.deepEqual(await shown(), ["1", "3"]); // Names remain case-insensitive.
    await option("Unassigned: off").click();
    assert.deepEqual(await shown(), ["1", "3", "4"]);
    await option("Sol: included").click();
    assert.deepEqual(await shown(), ["4"]);
    await clear(); // Outside click closes the menu and clears all choices.
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    assert.equal(await page.getByRole("listbox").count(), 0);

    // Keyboard selection stays open and cycles the highlighted row.
    await filter("fPriority").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.deepEqual(await shown(), ["2"]);
    await page.keyboard.press("Enter");
    assert.deepEqual(await shown(), ["1", "3", "4"]);
    await page.keyboard.press("Space");
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("listbox").count(), 0);

    // Existing viewer selections migrate naturally on the next click.
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.local.view = { label: "a", priority: 3, assignee: "SOL" };
      scribe.changed();
    });
    assert.deepEqual(await shown(), ["1", "3"]);
    await filter("fLabel").click();
    await option("Alpha: included").click();
    assert.deepEqual(await shown(), []);
    await clear();

    // Different filter groups intersect their matches.
    await filter("fLabel").click();
    await option("Beta: off").click();
    await filter("fPriority").click();
    await option("High: off").click();
    assert.deepEqual(await shown(), ["3"]);
    await clear();

    // Retained rows reflect renamed options and choose their current index after reordering.
    await filter("fLabel").click();
    await option("Alpha: off").hover();
    // Off the list, so the reordered rows don't put another one under the pointer before the read.
    await page.mouse.move(0, 0);
    assert.deepEqual(await page.evaluate(async () => {
      const scribe = (window as any).scribe;
      const alpha = document.querySelector('[role="option"][aria-label="Alpha: off"]')!;
      const beta = document.querySelector('[role="option"][aria-label="Beta: off"]')!;
      scribe.state.labels = [{ id: "c", name: "Gamma" }, { id: "a", name: "Renamed Alpha" }];
      scribe.changed();
      // A remote change paints on the next frame (or the fallback timer), not in the same task.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return [alpha.isConnected, beta.isConnected, alpha.getAttribute("aria-label"), alpha.classList.contains("active")];
    }), [true, false, "Renamed Alpha: off", true]);
    await option("Renamed Alpha: off").click();
    assert.deepEqual(await shown(), ["1", "3"]);
    await option("Renamed Alpha: included").click();
    assert.deepEqual(await shown(), ["2", "4"]);
    await option("Renamed Alpha: excluded").click();
    assert.deepEqual(await shown(), ["1", "2", "3", "4"]);
    // Keyboard selection also follows the retained active row, rather than its old index.
    await page.keyboard.press("Enter");
    assert.deepEqual(await shown(), ["1", "3"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
