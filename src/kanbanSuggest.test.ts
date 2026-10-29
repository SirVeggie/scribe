import { templateHtml } from "./testSupport/templates.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { launchChromium } from "./chromium.js";

/** The board with a scribe stub whose classifier answers when the test says so (window.answer). */
const STUB = `<script>
  window.scribe = {
    state: {
      columns: [{ id: 'todo', title: 'Todo' }],
      labels: [
        { id: 'lb1', name: 'Bug', color: '#ff6b7a' },
        { id: 'lb2', name: 'Feature', color: '#6ea8ff', description: 'New behaviour' }
      ],
      nextNum: 3, settings: { suggest: true },
      cards: [
        { id: 'c1', num: 1, col: 'todo', title: 'Old card', description: '', labels: [], priority: 0 },
        { id: 'c2', num: 2, col: 'todo', title: 'Labelled card', description: '', labels: ['lb1'], priority: 2 }
      ]
    }, local: {},
    // Like the bridge: writes replace what they change, and listeners with { local: true } hear them.
    set(patch) { this.state = { ...this.state, ...patch }; this.wrote(); },
    setLocal(patch) { Object.assign(this.local, patch); },
    onChange(fn, opts) { this.changed = fn; this.hearsLocal = Boolean(opts && opts.local); },
    wrote() { if (this.hearsLocal) queueMicrotask(() => this.changed(this.state, { source: 'local', ops: null })); },
    update(ops) {
      for (const op of ops) {
        const m = /^cards\\/id=([^/]+)\\/suggest$/.exec(op.path);
        const at = m ? this.state.cards.findIndex(c => c.id === m[1]) : -1;
        if (at < 0) throw new Error('unexpected op ' + JSON.stringify(op));
        const card = { ...this.state.cards[at] };
        if (op.op === 'set') card.suggest = op.value;
        else if (op.op === 'remove') delete card.suggest;
        else throw new Error('unexpected op ' + op.op);
        this.state = { ...this.state, cards: this.state.cards.slice() };
        this.state.cards[at] = card;
      }
      this.wrote();
    },
    agent: { show() { return Promise.resolve({ ok: true }); } },
    permissions: {
      asked: 0,
      request(perm) { this.asked += 1; this.last = perm; return Promise.resolve({ ok: true, granted: window.grant !== false }); }
    },
    ml: {
      calls: [], waiting: [],
      capabilities() { return Promise.resolve({ ok: true, available: true, permission: 'allow' }); },
      decide(request) { this.calls.push(request); return new Promise(resolve => this.waiting.push(resolve)); }
    }
  };
  /** Answer the oldest waiting decide(): yes holds the label names to say yes to. */
  window.answer = (yes, priority, extra) => {
    const ml = window.scribe.ml;
    const request = ml.calls[ml.calls.length - ml.waiting.length];
    const answers = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === 'yesno') answers[id] = { type: 'yesno', yes: yes.some(name => q.instructions.includes('"' + name + '"')) ? 0.9 : 0.1 };
      else answers[id] = { type: 'choice', choice: priority || 'unspecified', probabilities: { [priority || 'unspecified']: 0.8 }, confidence: 0.7 };
    }
    ml.waiting.shift()(extra || { ok: true, answers, cached: false, ms: 5 });
  };
</script>`;

async function board(t: { skip: (why: string) => void }) {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Kanban suggestions test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) {
      t.skip("no Chromium installed");
      return null;
    }
    throw error;
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const html = templateHtml("kanban");
  await page.setContent(`${STUB}${html}`);
  return { browser, page, errors };
}

const calls = (page: Page) => page.evaluate(() => (window as any).scribe.ml.calls.length);
const waitCalls = (page: Page, count: number) => page.waitForFunction((n) => (window as any).scribe.ml.calls.length === n, count);
const cardOf = (page: Page, id: string) => page.evaluate((id) => (window as any).scribe.state.cards.find((c: any) => c.id === id), id);

test("label settings persist descriptions and exclude never-suggest labels, including late answers", async (t) => {
  const open = await board(t);
  if (!open) return;
  const { browser, page, errors } = open;
  try {
    await page.locator("#labelsBtn").click();
    assert.equal(await page.locator(".menu textarea, .menu input[type=checkbox]").count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Label name", exact: true }).count(), 2);
    await page.getByRole("button", { name: "Settings for Bug", exact: true }).click();
    const description = page.getByRole("textbox", { name: "Description for Bug", exact: true });
    await description.fill("Broken existing behaviour");
    await page.getByRole("button", { name: "← Back", exact: true }).click();
    assert.equal(await page.locator(".menu textarea, .menu input[type=checkbox]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Settings for Bug", exact: true }).evaluate(b => b === document.activeElement), true);
    await page.getByRole("button", { name: "Settings for Feature", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Description for Feature", exact: true }).inputValue(), "New behaviour");
    assert.equal(await page.getByRole("checkbox", { name: "Never suggest", exact: true }).isChecked(), false);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const s = (window as any).scribe;
      s.state.cards[0] = { ...s.state.cards[0], title: "Crash on save" };
      s.changed();
    });
    await waitCalls(page, 1);
    assert.match(await page.evaluate(() => (window as any).scribe.ml.calls[0].questions.label0.instructions), /Broken existing behaviour/);

    // Disable while the answer is in flight: it must not reintroduce the label.
    await page.locator("#labelsBtn").click();
    await page.getByRole("button", { name: "Settings for Bug", exact: true }).click();
    await page.getByRole("checkbox", { name: "Never suggest", exact: true }).first().check();
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).answer(["Bug", "Feature"]));
    await page.locator('.card[data-id="c1"] .suggest-yes').waitFor();
    assert.deepEqual((await cardOf(page, "c1")).suggest, { labels: ["lb2"] });

    await page.evaluate(() => {
      const s = (window as any).scribe;
      s.state.cards[0] = { ...s.state.cards[0], description: "More detail" };
      s.changed();
    });
    await waitCalls(page, 2);
    const request = await page.evaluate(() => (window as any).scribe.ml.calls[1]);
    assert.equal(Object.values(request.questions).some((q: any) => q.instructions.includes('"Bug"')), false);

    await page.locator('.card[data-id="c2"] .card-title').click();
    assert.equal(await page.locator("#mLabels .label-chip").getAttribute("data-tooltip"), "Broken existing behaviour");
    await page.keyboard.press("Escape");
    await page.locator("#labelsBtn").click();
    await page.getByRole("button", { name: "Settings for Bug", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Description for Bug", exact: true }).inputValue(), "Broken existing behaviour");
    assert.equal(await page.getByRole("checkbox", { name: "Never suggest", exact: true }).first().isChecked(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("a new card gets label and priority suggestions the user accepts or dismisses", async (t) => {
  const open = await board(t);
  if (!open) return;
  const { browser, page, errors } = open;
  try {
    // Cards that were already there are not asked about.
    await page.locator('.column[data-col="todo"] .add-card').click();
    await page.locator(".composer-input").fill("Crash when saving a note");
    await page.locator(".composer-input").press("Enter");
    await waitCalls(page, 1);
    const request = await page.evaluate(() => (window as any).scribe.ml.calls[0]);
    assert.deepEqual(request.state, { title: "Crash when saving a note", description: "" });
    assert.deepEqual(Object.keys(request.questions), ["label0", "label1", "priority"]);
    assert.equal(request.questions.label0.instructions, 'Should this card have the label "Bug"?');
    assert.equal(request.questions.label1.instructions, 'Should this card have the label "Feature"? The label means: New behaviour');
    assert.deepEqual(Object.keys(request.questions.priority.options), ["unspecified", "low", "medium", "high", "urgent"]);

    await page.evaluate(() => (window as any).answer(["Bug"], "urgent"));
    const tile = page.locator(".card", { hasText: "Crash when saving a note" });
    await tile.locator(".suggest-chip").nth(1).waitFor();
    assert.deepEqual(await tile.locator(".suggest-yes").allInnerTexts(), ["Bug", "Urgent priority"]);
    const id = (await tile.getAttribute("data-id"))!;
    // Nothing is applied until the user takes it.
    let card = await cardOf(page, id);
    assert.deepEqual([card.labels, card.priority, card.suggest], [[], 0, { labels: ["lb1"], priority: 4 }]);

    // The card's dialog offers the same chips.
    await tile.locator(".card-title").click();
    assert.deepEqual(await page.locator("#mSuggest .suggest-yes").allInnerTexts(), ["Bug", "Urgent priority"]);
    await page.locator("#mSuggest .suggest-yes").first().click();
    card = await cardOf(page, id);
    assert.deepEqual([card.labels, card.priority, card.suggest], [["lb1"], 0, { priority: 4 }]);
    assert.deepEqual(await page.locator("#mSuggest .suggest-yes").allInnerTexts(), ["Urgent priority"]);
    await page.keyboard.press("Escape");

    await tile.locator(".suggest-no").click();
    card = await cardOf(page, id);
    assert.deepEqual([card.labels, card.priority, card.suggest], [["lb1"], 0, { no: ["priority"] }]);
    assert.equal(await tile.locator(".suggest-row").count(), 0);

    // A later edit asks only about what the card lacks and the user has not dismissed.
    await page.evaluate((id) => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any) => c.id === id ? { ...c, description: "It also loses the text" } : c);
      scribe.changed();
    }, id);
    await waitCalls(page, 2);
    const again = await page.evaluate(() => (window as any).scribe.ml.calls[1]);
    assert.deepEqual(Object.keys(again.questions), ["label0"]);
    assert.match(again.questions.label0.instructions, /"Feature"/);
    await page.evaluate(() => (window as any).answer(["Feature"]));
    await tile.locator(".suggest-chip").waitFor();
    assert.deepEqual((await cardOf(page, id)).suggest, { labels: ["lb2"], no: ["priority"] });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("a card an agent adds is asked about too, and an answer for text that has changed is dropped", async (t) => {
  const open = await board(t);
  if (!open) return;
  const { browser, page, errors } = open;
  try {
    const claim = { thread: "th_1", by: "Sol", at: 1 };
    await page.evaluate((claim) => {
      const scribe = (window as any).scribe;
      scribe.state.cards.push({
        id: "c9", num: 9, col: "todo", title: "Add dark mode", description: "", labels: [], priority: 0,
        assignee: "Sol", status: { kind: "working", text: "On it" }, claim,
      });
      scribe.changed();
    }, claim);
    await waitCalls(page, 1);
    // The title changes while the classifier is still answering.
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any) => c.id === "c9" ? { ...c, title: "Fix the login crash" } : c);
      scribe.changed();
    });
    await page.evaluate(() => (window as any).answer(["Feature"], "low"));
    await page.waitForTimeout(100);
    assert.equal((await cardOf(page, "c9")).suggest, undefined);
    assert.equal(await page.locator('.card[data-id="c9"] .suggest-row').count(), 0);

    // The new text gets its own question, and its answer lands.
    await waitCalls(page, 2);
    assert.equal(await page.evaluate(() => (window as any).scribe.ml.calls[1].state.title), "Fix the login crash");
    await page.evaluate(() => (window as any).answer(["Bug"], "high"));
    await page.locator('.card[data-id="c9"] .suggest-chip').nth(1).waitFor();
    const card = await cardOf(page, "c9");
    assert.deepEqual(card.suggest, { labels: ["lb1"], priority: 3 });
    assert.deepEqual([card.labels, card.priority, card.assignee, card.status, card.claim], [[], 0, "Sol", { kind: "working", text: "On it" }, claim]);

    // A failed answer leaves the card as it is.
    await page.evaluate(() => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any) => c.id === "c1" ? { ...c, title: "Old card, renamed" } : c);
      scribe.changed();
    });
    await waitCalls(page, 3);
    await page.evaluate(() => (window as any).answer([], "", { ok: false, error: "timeout", message: "too slow" }));
    await page.waitForTimeout(100);
    assert.equal((await cardOf(page, "c1")).suggest, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("the board setting asks for the classifier permission and stops the questions when off", async (t) => {
  const open = await board(t);
  if (!open) return;
  const { browser, page, errors } = open;
  try {
    const rename = (title: string) => page.evaluate((title) => {
      const scribe = (window as any).scribe;
      scribe.state.cards = scribe.state.cards.map((c: any) => c.id === "c1" ? { ...c, title: title } : c);
      scribe.changed();
    }, title);
    const setting = () => page.evaluate(() => (window as any).scribe.state.settings.suggest);
    await page.locator("#settingsBtn").click();
    assert.equal(await page.locator("#sSuggest").isChecked(), true);
    await page.locator("#sSuggest").click();
    assert.equal(await setting(), undefined);
    await rename("Renamed while off");
    await page.waitForTimeout(1900);
    assert.equal(await calls(page), 0);

    // Not allowed: the switch goes back and says why.
    await page.evaluate(() => { (window as any).grant = false; });
    await page.locator("#sSuggest").click();
    await page.locator("#sSuggestNote", { hasText: "Suggestions stay off" }).waitFor();
    assert.deepEqual([await page.locator("#sSuggest").isChecked(), await setting()], [false, undefined]);

    await page.evaluate(() => { (window as any).grant = true; });
    await page.locator("#sSuggest").click();
    await page.waitForFunction(() => (window as any).scribe.state.settings.suggest === true);
    assert.deepEqual(await page.evaluate(() => [(window as any).scribe.permissions.asked, (window as any).scribe.permissions.last]), [2, "ml.decide"]);
    await rename("Renamed while on");
    await waitCalls(page, 1);

    // The page's permission was taken away on this PC: one refusal ends the questions.
    await page.evaluate(() => (window as any).answer([], "", { ok: false, error: "denied", message: "no" }));
    await rename("Renamed after the refusal");
    await page.waitForTimeout(1900);
    assert.equal(await calls(page), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
