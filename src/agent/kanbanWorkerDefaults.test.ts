import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { cardContext } from "./cardContext.js";
import { kanbanActions } from "../actions/kanban.js";
import { MAX_FILES_PER_MESSAGE } from "./attachments.js";

const board = fs.readFileSync(new URL("../../templates/builtin/kanban.html", import.meta.url), "utf8");
const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

test("Ask card context includes full text, old comments, resolved fields and image bytes without changing the board", () => {
  const assetId = "pa_aaaaaaaaaaaaaaaaaaaaaaaa";
  const state = {
    columns: [{ id: "in", title: "Inbox" }], labels: [{ id: "bug", name: "Bug" }],
    cards: [{ id: "c", num: 1, col: "in", title: "Question", description: "details".repeat(5000),
      priority: 3, due: "2026-10-20", labels: ["bug"], assignee: "Person",
      checklist: [{ text: "Check it", done: true }],
      comments: Array.from({ length: 20 }, (_, i) => ({ by: "user", text: `Comment ${i}: ` + "text".repeat(1000) })),
      images: [{ id: "im_1", name: "shot.png", data: `/blob/${assetId}` }] }],
  };
  const before = JSON.stringify(state);
  const pages: Parameters<typeof cardContext>[0] = {
    runAction(board, action, args, caller) {
      assert.equal(board, "board");
      const result = kanbanActions.actions[action].run(state, args as Record<string, unknown>, { caller, now: 1, values: {} });
      assert.deepEqual(result.ops, []);
      return { result: result.result, stateRevision: 1, tab: {} as any };
    },
    readTabPageAsset(board, id) {
      assert.equal(board, "board"); assert.equal(id, assetId);
      return { meta: { id, tabId: board, name: "shot.png", mimeType: "image/png", bytes: 5, createdAt: 1 }, data: Buffer.from("image") };
    },
  };
  const scope = { kind: "page" as const, ref: "board" };
  const result = cardContext(pages, scope, 1);
  const snapshot = JSON.parse(result.text.slice(result.text.indexOf("\n") + 1));
  assert.equal(snapshot.description, state.cards[0].description);
  assert.deepEqual(snapshot.comments, state.cards[0].comments);
  assert.equal(snapshot.priority, 3);
  assert.equal(snapshot.due, "2026-10-20");
  assert.deepEqual(snapshot.labels, ["Bug"]);
  assert.deepEqual(snapshot.checklist, state.cards[0].checklist);
  assert.equal(snapshot.column, "Inbox");
  assert.deepEqual(result.images, [{ name: "shot.png (im_1)", mimeType: "image/png", data: Buffer.from("image").toString("base64") }]);
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => cardContext(pages, { kind: "global", ref: null }, 1), /page thread/);
  assert.throws(() => cardContext(pages, scope, "1"), /card number/);
  const full = cardContext(pages, scope, 1, Array.from({ length: MAX_FILES_PER_MESSAGE }, () => ({ data: "" })));
  assert.deepEqual(full.images, []);
  assert.match(full.text, /shot.png.*message attachment limit/);
  const missing = cardContext({ ...pages, readTabPageAsset() { throw new Error("asset not found"); } }, scope, 1);
  assert.deepEqual(missing.images, []);
  assert.match(missing.text, /shot.png.*asset not found/);
});

test("page launch forwards card context through the bridge into the first message", async () => {
  const bridge = fs.readFileSync(new URL("../bridge.ts", import.meta.url), "utf8");
  const calls: any[] = [];
  const context = vm.createContext({
    S: { threads: new Map(), details: new Map() }, PAGE_PROMPT_MAX: 20000,
    pageThreadSettings: () => ({}), pageMayWrite: async () => ({ ok: true }),
    pageSentAt: new Map(), showPageThread: () => {},
    api: async (method: string, url: string, body: any) => {
      calls.push({ url, body });
      return url === "/threads" ? { thread: { id: "new" } } : {};
    },
  });
  vm.runInContext([fn(bridge, "agentSettings"), fn(chat, "pageImages")].join("\n"), context);
  vm.runInContext(chat.match(/^  async function pageRequest\([^]*?^  }/m)![0], context);
  await vm.runInContext("pageRequest({ id: 'board' }, { ...agentSettings({ cardContext: 42 }), op: 'start', prompt: 'Question' })", context);
  assert.equal(calls[1].url, "/threads/new/messages");
  assert.equal(calls[1].body.cardContext, 42);
});

test("page usage snapshots and board preserve Codex reports past reset", () => {
  const now = Date.now();
  const limits = {
    codex: { windows: [{ label: "5 hours", utilization: 1, resetsAt: now - 1000 }], ordinaryUsageAllowed: false },
    claude: { windows: [{ label: "5 hours", utilization: 0.8, resetsAt: now - 1000 }] },
    cursor: { windows: [{ label: "Month", utilization: 0.5, resetsAt: now - 1000 }] },
  };
  const context = vm.createContext({
    S: { config: { limits } },
    clamp: (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)),
  });
  vm.runInContext([fn(chat, "liveWindows"), fn(chat, "planLimits"), fn(chat, "pageLimits"), fn(board, "workerQuotaWindow")].join("\n"), context);
  const snapshot = vm.runInContext("pageLimits()", context);
  assert.equal(snapshot.codex.windows[0].utilization, 1);
  assert.equal(snapshot.codex.ordinaryUsageAllowed, false);
  // Claude reports pass through as they are, like Codex; the board zeroes a passed Claude window itself.
  assert.equal(snapshot.claude.windows[0].utilization, 0.8);
  assert.equal(snapshot.cursor.windows[0].utilization, 0);
  assert.equal(vm.runInContext("workerQuotaWindow('codex', pageLimits().codex.windows[0]).percent", context), 100);
  assert.match(vm.runInContext("workerQuotaWindow('codex', pageLimits().codex.windows[0]).reset", context), /awaiting update/);
  assert.equal(vm.runInContext("workerQuotaWindow('claude', pageLimits().claude.windows[0]).percent", context), 0);
});

test("usage changes reach subscribed pages and forget closed pages", () => {
  const watch = new Set(["open", "closed"]);
  const events: Array<{ id: string; message: any }> = [];
  const context = vm.createContext({
    pageLimitWatch: watch,
    pageLimits: () => ({ codex: { windows: [{ utilization: 0.5 }] } }),
    app: () => ({ tabs: () => [{ id: "open" }], postToPage: (id: string, message: any) => events.push({ id, message }) }),
  });
  vm.runInContext(fn(chat, "pageLimitsChanged") + "\npageLimitsChanged();", context);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "open");
  assert.equal(events[0].message.type, "scribe-agent-limits");
  assert.equal(events[0].message.limits.codex.windows[0].utilization, 0.5);
  assert.deepEqual([...watch], ["open"]);
});

// Execute the shipped board's launch helpers and the chat's settings resolver together.
function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

test("board slot display follows provider and total limits and saves Any explicitly", () => {
  const workers: any = {
    sol: { provider: "codex", run: {}, threadId: "first" },
    web: { provider: "codex", run: {} },
    other: { provider: "claude", run: {} },
    implicit: { run: {} },
  };
  let settings: any = {};
  const context = vm.createContext({
    settings: () => settings, worker: (id: string) => workers[id],
    workerIds: () => Object.keys(workers), workerOn: (w: any) => Boolean(w.run),
    stepLeased: (w: any) => Boolean(w.step), launching: {}, agentOptions: null,
    soloRuns: (w: any) => w.solo || {},
    workerDefaults: () => ({ provider: "codex" }), str: (x: any) => x || "",
    clamp: (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)),
    scribe: { set: (value: any) => { settings = value.settings; } },
  });
  const helpers = board.slice(board.indexOf("  function maxWorkers()"), board.indexOf("  /** Scribe (or a window with an older copy"));
  vm.runInContext(helpers + "\n" + fn(board, "saveSetting"), context);
  const limited = (id: string) => vm.runInContext(`atLimit('${id}')`, context);
  assert.equal(limited("web"), true);
  assert.equal(limited("implicit"), true);
  assert.equal(limited("other"), false);
  vm.runInContext("saveSetting('maxWorkersPerProvider', 0)", context);
  assert.equal(settings.maxWorkersPerProvider, 0);
  assert.equal(limited("web"), false);
  settings.maxWorkers = 1;
  assert.equal(limited("other"), true);
  settings = { maxWorkersPerProvider: 2 };
  assert.equal(limited("web"), false);
  workers.implicit.step = {};
  assert.equal(limited("web"), true);
  // One-card runs take slots too, even a stopped worker's or the worker's own.
  delete workers.implicit.step;
  workers.implicit.run = null;
  workers.implicit.solo = { manual: { card: 1 } };
  assert.equal(limited("web"), true);
  workers.implicit.solo = null;
  workers.web.solo = { manual: { card: 1 } };
  assert.equal(limited("web"), true);
  workers.web.solo = null;
  assert.equal(limited("sol"), false, "there is room for a second chat for the same worker");
  settings.maxWorkersPerProvider = 1;
  assert.equal(limited("sol"), true, "its own active chat occupies a provider slot");
  settings.maxWorkersPerProvider = 3;
  workers.sol.step = {};
  assert.equal(limited("web"), false);
  workers.sol.solo = { queued: { card: 2, queued: true } };
  assert.equal(limited("web"), true, "the active chat, parallel lease and queued run take separate slots");
});

test("worker status and Stop now include every automatically queued chat and preserve manual runs", async () => {
  const w: any = { run: { card: 1 }, threadId: "first", solo: {
    second: { card: 2, queued: true }, manual: { card: 3 },
  } };
  const released: string[] = [], stopped: string[] = [];
  let stopNow: () => void = () => {};
  const context = vm.createContext({
    stopWorkerId: "sol", worker: () => w, soloRuns: (worker: any) => worker.solo || {},
    threadStatus: { first: { status: "running" }, second: { status: "running" } },
    $: () => ({ addEventListener: (_event: string, handler: () => void) => { stopNow = handler; } }),
    closeStop: () => {}, patchWorker: (_id: string, patch: any) => Object.assign(w, patch),
    endRun: () => { delete w.run; delete w.threadId; }, render: () => {},
    scribe: { agent: { release: (id: string) => released.push(id), stop: async (id: string) => { stopped.push(id); return { ok: true }; } } },
  });
  vm.runInContext(["workerChats", "workerRunning", "workerCardNames"].map(name => fn(board, name)).join("\n"), context);
  assert.equal(vm.runInContext("workerRunning(worker())", context), true);
  assert.equal(vm.runInContext("workerCardNames(worker())", context), "#1, #2");
  const start = board.indexOf('  $("stopNow").addEventListener');
  vm.runInContext(board.slice(start, board.indexOf("\n  });", start) + 7), context);
  stopNow();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ["first", "second"]);
  assert.deepEqual(stopped, ["first", "second"]);
  assert.deepEqual(Object.keys(w.solo), ["manual"]);
  assert.equal(vm.runInContext("workerRunning(worker())", context), false);
});

test("Continue requests the continuation; it resumes only the same worker's chat", async () => {
  for (const assignee of ["New", "Old"]) {
    const calls: any[] = [];
    let click: () => void = () => {};
    const state: any = {
      columns: [{ id: "ready", title: "Ready", role: "agent" }, { id: "review", title: "Review", role: "review" }],
      settings: { workers: { old: { name: "Old" }, next: { name: "New" } } },
      cards: [{ id: "card", num: 525, title: "Follow up", col: "review", from: "ready", thread: "earlier", assignee, threadAssignee: "Old",
        comments: [{ id: "comment", by: "user", at: 1, text: "Go on" }] }],
    };
    const context = vm.createContext({
      card: () => state.cards[0],
      workerIdFor: (name: string) => Object.keys(state.settings.workers).find(id => state.settings.workers[id].name === name),
      str: (v: any) => v == null ? "" : String(v),
      scribe: { action: async (name: string, args: any) => {
        calls.push([name, args]);
        return kanbanActions.actions[name].run(state, args, { caller: { by: "user" }, now: 1, values: {} }).result;
      } },
      setHint: (text: string) => calls.push(["hint", text]),
      el: (tag: string, cls: string, text: string) => ({
        dataset: {}, appendChild: () => {},
        addEventListener: (event: string, cb: any) => { if (text === "Continue") click = () => cb({ stopPropagation() {} }); },
      }),
    });
    vm.runInContext(fn(board, "followUpButtons"), context);
    vm.runInContext("followUpButtons(card(), { id: 'comment' })", context);
    click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(["continue", { card: 525, comment: "comment" }]));
    assert.deepEqual(calls[1], ["hint", "Continuation requested for #525."]);
    const { ops } = kanbanActions.actions.continue.run(state, calls[0][1], { caller: { by: "user" }, now: 1, values: {} });
    const continuation = (ops[0] as any).value.continuation;
    assert.equal(continuation.assignee, assignee);
    assert.equal(continuation.comment, "comment");
    // A reassigned card starts the new worker fresh; the same worker gets its earlier chat back.
    assert.equal(continuation.thread, assignee === "Old" ? "earlier" : undefined);
  }
});

test("Ask uses the default worker and only updates the question comment, including on launch failure", async () => {
  for (const fail of [false, true]) {
    const c = { id: "card", num: 645, title: "Question", assignee: "Person", col: "review", thread: "old", status: { kind: "info", text: "Waiting" } };
    const before = JSON.stringify(c);
    const calls: any[] = [];
    const w = { name: "Default", provider: "codex", model: "chosen-model", mode: "code", cwd: "C:/project", worktree: true };
    const context = vm.createContext({
      card: () => c, settings: () => ({ defaultWorker: "default" }), worker: (id: string) => id === "default" ? w : null,
      hasWorkerApi: () => true, workerMode: (w: any) => w.mode, workerName: (w: any) => w.name,
      FOLDER_MODES: { code: true, plan: true }, str: (v: any) => v == null ? "" : String(v),
      loadAgentOptions: async () => {}, workerOpts: (w: any) => ({ ...w }),
      boardTitle: () => "Board", workerInstructions: () => "Follow shared instructions", cardBrief: () => "Card context",
      askingComments: {}, threadStatus: {}, renderLater: () => {}, setHint: () => {},
      setComment: (card: string, cm: string, fields: any) => calls.push(["comment", fields.followUp]),
      scribe: { id: "board", agent: { start: async (prompt: string, opts: any) => {
        calls.push(["start", prompt, opts]); return fail ? { ok: false, error: "denied" } : { ok: true, threadId: "ask-chat" };
      } } }, launchError: () => "Denied",
    });
    vm.runInContext(["defaultAskWorker", "askPrompt", "askComment"].map(name => fn(board, name)).join("\n"), context);
    assert.equal(await vm.runInContext("askComment('card', 'comment', 'Why does this happen?')", context), !fail);
    assert.equal(JSON.stringify(c), before);
    const [, prompt, opts] = calls[0];
    assert.match(prompt, /Why does this happen\?/);
    assert.match(prompt, /NOT been claimed/);
    assert.match(prompt, /peek:scribe:page-key/);
    assert.equal(opts.model, "chosen-model");
    assert.equal(opts.provider, "codex");
    assert.equal(opts.cwd, "C:/project");
    assert.equal(opts.worktree, false);
    assert.equal(opts.cardContext, 645);
    assert.equal(opts.run.merge, false);
    assert.equal(w.worktree, true);
    assert.equal(opts.run.data.ask, true);
    assert.equal(opts.run.data.solo, undefined);
    assert.equal(calls[1][1], fail ? "askOffer" : "asked");
    assert.equal(vm.runInContext("Object.keys(askingComments).length", context), 0);
  }
});

test("comments on a person's card offer Ask only with a default worker, never send to its old chat", () => {
  for (const hasDefault of [false, true]) {
    const calls: any[] = [];
    const context = vm.createContext({
      hasCardApi: () => true, workerIdFor: () => null, defaultAskWorker: () => hasDefault ? "default" : null,
      setComment: (...args: any[]) => calls.push(args),
      scribe: { agent: { card: () => { throw new Error("Must not resume the old chat"); } } },
    });
    vm.runInContext(fn(board, "handOffComment"), context);
    vm.runInContext("handOffComment({ id: 'card', num: 645, thread: 'old', assignee: 'Person' }, 'comment', 'Question')", context);
    assert.equal(calls.length, hasDefault ? 1 : 0);
    if (hasDefault) assert.equal(calls[0][2].followUp, "offer");
  }
});

test("older cards resolve their earlier worker from retained bookkeeping and logs", () => {
  const context = vm.createContext({
    workerIds: () => ["old", "next"],
    worker: (id: string) => id === "old" ? { threadId: "last" } : {},
    settings: () => ({ workerLog: [{ thread: "finished", workerId: "old" }] }),
    arr: (v: any) => v || [],
  });
  vm.runInContext(fn(board, "soloRuns") + "\n" + fn(board, "changedCommentWorker"), context);
  for (const thread of ["last", "finished"]) {
    assert.equal(vm.runInContext(`changedCommentWorker({thread: '${thread}'}, 'next')`, context), true);
    assert.equal(vm.runInContext(`changedCommentWorker({thread: '${thread}'}, 'old')`, context), false);
  }
});

function harness(available = ["cursor", "codex", "claude", "pi"]) {
  const context = vm.createContext({
    agentOptions: {
      providers: available.map((id) => ({ id, available: true })),
      // Deliberately disagree with the worker's fixed defaults.
      defaults: { provider: "claude", model: "last-model", approval: "full", web: "on", fast: true },
    },
    FOLDER_MODES: new Set(["code", "plan"]),
    PAGE_MODES: new Set(["board", "ask", "code", "plan", "readonly"]),
    APPROVALS: ["readonly", "board", "edits", "auto", "full"].map((id) => ({ id })),
    READ_RUNGS: new Set(["readonly", "board"]),
    RUNG_LABELS: { readonly: "Read-only", board: "Board", edits: "Edits", auto: "Auto review", full: "Full access" },
    prefs: () => ({ provider: "claude", models: { claude: "last-model" }, web: "on" }),
    approvalFor: () => "full",
    modelChoice: () => ({ effort: "high", modelParams: { fast: "true", context: "last-context" } }),
    providerAvailable: (id: string) => available.includes(id),
    modelsOf: () => [],
    modelInfo: () => null,
    S: { config: { providers: available.map((id) => ({ id, available: true })) } },
    workerName: (w: { name?: string }) => w.name || "Sol",
    str: (value: unknown) => value == null ? "" : String(value),
    // workerOpts uses the board's object lookup, pageThreadSettings uses a Set.
    BOARD_FOLDER_MODES: { code: true, plan: true },
    BOARD_READ_RUNGS: { readonly: true, board: true },
  });
  vm.runInContext([
    fn(board, "workerDefaults"),
    fn(board, "workerRung").replaceAll("READ_RUNGS[", "BOARD_READ_RUNGS["),
    fn(board, "workerMode").replaceAll("READ_RUNGS[", "BOARD_READ_RUNGS["),
    fn(board, "workerOpts").replaceAll("FOLDER_MODES[mode]", "BOARD_FOLDER_MODES[mode]"),
    fn(chat, "webMode"),
    ...["parseRung", "rungRank", "accessMode", "pageAccess", "pageThreadSettings"].map((name) => fn(chat, name)),
    'function launch(w) { return pageThreadSettings(workerOpts(w, { num: 295, title: "Defaults" })); }',
  ].join("\n"), context);
  return (code: string) => JSON.parse(JSON.stringify(vm.runInContext(code, context)));
}

test("worker defaults ignore last-used chat choices through thread creation", () => {
  const run = harness();
  for (const provider of ["cursor", "codex", "claude", "pi"]) {
    const settings = run(`launch({ provider: '${provider}', cwd: 'C:/project' })`);
    assert.equal(settings.provider, provider);
    assert.equal(settings.model, provider === "cursor" ? "composer-2.5" : "default");
    assert.equal(settings.approval, "auto");
    assert.equal(settings.web, "off");
    assert.equal(settings.effort, null);
    assert.deepEqual(settings.modelParams, { fast: "false" });
  }
  assert.equal(run("launch({ cwd: 'C:/project' })").provider, "cursor");
});

test("displayed defaults and launched approval agree for a different provider", () => {
  const run = harness();
  const defaults = run("workerDefaults(agentOptions, 'codex')");
  const launch = run("launch({ provider: 'codex', cwd: 'C:/project' })");
  assert.equal(defaults.approval, launch.approval);
  assert.equal(defaults.web, launch.web);
  assert.equal(defaults.model, launch.model);
});

test("workers allow helpers by default and retain an explicit off choice", () => {
  const run = harness();
  for (const mode of ["code", "board"]) {
    const worker = { mode, cwd: "C:/project" };
    assert.equal(run(`launch(${JSON.stringify(worker)})`).helpersAllowed, true);
    assert.equal(run(`launch(${JSON.stringify({ ...worker, helpers: true })})`).helpersAllowed, true);
    assert.equal(run(`launch(${JSON.stringify({ ...worker, helpers: false })})`).helpersAllowed, undefined);
  }
});

test("explicit worker settings still win", () => {
  const run = harness();
  const launch = run("launch({ provider: 'codex', model: 'picked', effort: 'low', approval: 'full', web: 'limited', fast: 'true', cwd: 'C:/project', worktree: true })");
  assert.equal(launch.model, "picked");
  assert.equal(launch.effort, "low");
  assert.equal(launch.approval, "full");
  assert.equal(launch.web, "limited");
  assert.deepEqual(launch.modelParams, { fast: "true" });
  assert.equal(launch.useWorktree, true);
  assert.deepEqual(run("launch({ provider: 'claude', fast: 'flex', cwd: 'C:/project' })").modelParams, { fast: "flex" });
});

test("provider fallback is stable and page-only workers also receive fixed defaults", () => {
  const run = harness(["pi", "codex", "claude"]);
  const settings = run("launch({ mode: 'board' })");
  assert.equal(settings.provider, "codex");
  // A Pages worker from before the ladder runs on the Board rung (#719).
  assert.equal(settings.approval, "board");
  assert.equal(settings.mode, "board");
  assert.equal(run("launch({ mode: 'code', approval: 'ask', cwd: 'C:/project' })").approval, "edits");
  assert.equal(run("launch({ mode: 'board', approval: 'readonly' })").approval, "readonly");
  assert.equal(settings.web, "off");
  assert.equal(settings.cwd, null);
});

// Exercise the actual readiness and prompt helpers against changing board settings.
test("shared instructions enable workers and precede their own instructions in every launch", () => {
  const context = vm.createContext({
    shared: {},
    settings: () => vm.runInContext("shared", context),
    str: (value: unknown) => value == null ? "" : String(value),
    workerName: (w: { name?: string }) => w.name || "",
    FOLDER_MODES: { code: true, plan: true },
    workerMode: (w: { mode?: string }) => w.mode || "code",
    boardTitle: () => "Board",
    scribe: { id: "test-board" },
    cardBrief: () => "Your card: #303 Shared instructions",
  });
  vm.runInContext([fn(board, "workerInstructions"), fn(board, "workerReady"), fn(board, "workerPrompt")].join("\n"), context);
  const run = (code: string) => vm.runInContext(code, context);
  run("w = { name: 'Sol', cwd: 'C:/project', context: 'fresh' }; c = { num: 303, title: 'Shared instructions' }");
  assert.equal(run("workerReady(w)"), false);
  run("shared.workerInstructions = '  Shared rule.  '");
  assert.equal(run("workerReady(w)"), true);
  assert.equal(run("workerReady({ name: 'Sol' })"), false); // Code still needs a folder.
  assert.equal(run("workerReady({ name: 'Sol', mode: 'board' })"), true);
  assert.equal(run("workerReady({ mode: 'board' })"), false); // All workers need a name.
  assert.match(run("workerPrompt(w, c)"), /The user's instructions:\nShared rule\.\n\nYour card/);
  run("w.instructions = '  Worker rule.  '");
  for (const solo of [false, true]) {
    assert.match(run(`workerPrompt(w, c, '', ${solo})`), /Shared rule\.\n\nWorker rule\./);
  }
  run("shared.workerInstructions = 'Changed shared rule.'");
  assert.match(run("workerPrompt(w, c)"), /Changed shared rule\.\n\nWorker rule\./);
  run("delete shared.workerInstructions");
  assert.equal(run("workerReady(w)"), true); // Legacy worker-only setups still run.
  assert.equal(run("workerInstructions(w)"), "Worker rule.");
  run("w.instructions = '  '; shared.workerInstructions = '  '");
  assert.equal(run("workerReady(w)"), false);
  assert.match(run("workerPrompt(w, c, 'Preview placeholder')"), /The user's instructions:\nPreview placeholder/);
});

test("template agent actions ignore last-used chat model through thread creation", () => {
  const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const context = vm.createContext({
    S: { config: { providers: ["cursor", "codex", "claude", "pi"].map((id) => ({ id, available: true })) } },
    prefs: () => ({ provider: "claude", models: { claude: "opus-expensive" }, web: "on" }),
    providerAvailable: (id: string) => true,
    modelsOf: () => [{ id: "opus-expensive" }, { id: "default" }],
    modelInfo: () => ({ efforts: [{ id: "high" }] }),
    modelChoice: () => ({ effort: "high", modelParams: { fast: "true" } }),
    approvalFor: () => "full",
    webMode: (w?: string, fallback?: string) => w || fallback || "off",
    PAGE_MODES: new Set(["board", "ask", "code", "plan", "readonly"]),
    FOLDER_MODES: new Set(["code", "plan"]),
    APPROVALS: ["readonly", "board", "edits", "auto", "full"].map((id) => ({ id })),
    READ_RUNGS: new Set(["readonly", "board"]),
  });
  const providerPref = chat.match(/^  const AGENT_ACTION_PROVIDER_PREF = .*;/m);
  const agentActionFn = chat.match(/^  function agentActionThreadInput\([^]*?^  }/m);
  const pageThreadFn = chat.match(/^  function pageThreadSettings\([^]*?^  }/m);
  assert.ok(providerPref && agentActionFn && pageThreadFn);
  const helpers = ["parseRung", "rungRank", "accessMode", "pageAccess"].map((name) => fn(chat, name));
  vm.runInContext([providerPref[0], agentActionFn[0], ...helpers, pageThreadFn[0], 'function launch(thread) { return pageThreadSettings(agentActionThreadInput(thread)); }'].join("\n"), context);
  const run = (code: string) => vm.runInContext(code, context);
  const triage = run('launch({ title: "Triage: Board" })');
  assert.equal(triage.provider, "cursor");
  assert.equal(triage.model, "composer-2.5");
  assert.equal(triage.approval, "board");
  assert.equal(triage.mode, "board");
  assert.equal(run('launch({ mode: "readonly" })').approval, "readonly");
  assert.equal(triage.web, "off");
  assert.equal(triage.modelParams?.fast, "false");
  assert.equal(triage.effort, null);
  const explicit = run('launch({ provider: "claude", model: "picked" })');
  assert.equal(explicit.provider, "claude");
  assert.equal(explicit.model, "picked");
});
