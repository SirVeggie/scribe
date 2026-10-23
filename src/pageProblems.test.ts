import assert from "node:assert/strict";
import { test } from "node:test";
import { PageProblems, cleanProblems, PAGE_PROBLEM_JS } from "./pageProblems.js";
import { launchChromium } from "./chromium.js";

test("reports are capped, deduplicated and bounded", () => {
  assert.deepEqual(cleanProblems([null, {}, {code: "error", message: "x", line: -1}, {code: "error", message: "x"}]), [{code: "error", message: "x"}]);
  const problems = cleanProblems(Array.from({length: 100}, (_, i) => ({code: "error" + i, message: String(i) + "x".repeat(500), line: 3})));
  assert.equal(problems.length, 8);
  assert.equal(problems[0].message.length, 300);
  const flood = cleanProblems([
    ...Array.from({length: 10}, (_, i) => ({code: "asset_load", message: `image ${i}`})),
    {code: "uncaught_error", message: "broken script"}, {code: "reply_field_name", message: "missing name"},
  ]);
  assert.equal(flood[0].code, "uncaught_error");
  assert.equal(flood.filter(p => p.code === "asset_load").length, 3);
  assert.ok(flood.some(p => p.code === "reply_field_name"));
});

test("sessions isolate revisions and tokens, check links, cancel probes and omit timed-out reports", async () => {
  const reports = new PageProblems();
  let fallback = false;
  const first = reports.collect("t_a", 1, async () => { fallback = true; });
  const old = reports.boot("t_a", 1)!;
  const second = reports.collect("t_a", 2, async () => { fallback = true; }, {exists: key => key === "scribe:yes" ? true : key === "scribe:private" ? undefined : false});
  assert.deepEqual(await first, []);
  assert.equal(reports.boot("t_a", 1), undefined);
  const current = reports.boot("t_a", 2)!;
  reports.report("t_a", {...old, phase: "done", problems: [{code: "stale", message: "no"}]});
  reports.report("t_a", {...current, phase: "done", problems: [], links: ["scribe:yes", "scribe:no", "scribe:private", 123]});
  assert.deepEqual(await second, [{code: "missing_page", message: "Page link does not exist: scribe:no"}]);
  assert.equal(fallback, false);
  let signal: AbortSignal | undefined;
  const timed = reports.collect("t_a", 3, async value => { signal = value; }, {timeoutMs: 260});
  assert.deepEqual(await timed, []);
  assert.equal(signal?.aborted, true);
  assert.equal(reports.boot("t_a", 3), undefined);
  const extended = reports.collect("t_a", 4, async () => {}, {timeoutMs: 20});
  const boot = reports.boot("t_a", 4)!;
  await new Promise(resolve => setTimeout(resolve, 40));
  reports.report("t_a", {...boot, phase: "done", problems: [{code: "uncaught_error", message: "cold start"}]});
  assert.deepEqual(await extended, [{code: "uncaught_error", message: "cold start"}]);
});

test("first-render collector catches scripts, assets, rejections, handled bridge failures and dynamic kit lint", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Page diagnostics test" });
  try {
    const page = await browser.newPage();
    const posts: any[] = [];
    await page.route("http://diagnostics.test/**", route => {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
        return route.fulfill({status: 204});
      }
      if (route.request().url().endsWith("/bad.png")) return route.fulfill({status: 404});
      if (route.request().url().endsWith("/kit.css")) return route.fulfill({contentType: "text/css", body: ".tag{color:red}"});
      if (route.request().url().endsWith("/external.js")) return route.fulfill({contentType: "text/javascript", body: "throw new Error('external failure')"});
      return route.fulfill({contentType: "text/html", body: `<!doctype html><head><link rel="stylesheet" href="/kit.css"><style>.success{color:green}</style><script>
window.__SCRIBE_PROBLEMS__={id:'t_a',token:'token',insertLine:0,insertedLines:0,tones:['ok','warn']};
${PAGE_PROBLEM_JS}
window.scribe={fail:function(){return Promise.resolve({ok:false,error:'bad call'});},throwing:function(){throw new Error('sync bridge');}};
window.originalFail=scribe.fail;
window.__scribeWatchProblems();
</script></head><body>
<script>throw new Error('page exploded')</script>
<script src="/external.js"></script>
<script>Promise.reject(new Error('rejected page')); scribe.fail().then(function(){}); try {scribe.throwing()} catch(e) {}</script>
<img src='/bad.png'>
<form id='reply' data-reply><input><textarea name='valid'></textarea></form>
<input form='reply'><div class='tag warning'>warning</div><div class='tag success'>valid custom tone</div><div class='tag custom-class'>valid</div>
<a data-scribe-open='scribe:missing#anchor'>link</a>
</body>`});
    });
    const finished = page.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.phase === "done");
    await page.goto("http://diagnostics.test/");
    await finished;
    const done = posts.find(p => p.phase === "done");
    assert.ok(done, JSON.stringify(posts));
    for (const code of ["uncaught_error", "unhandled_rejection", "bridge_error", "asset_load", "reply_field_name", "unknown_tone"]) {
      assert.ok(done.problems.some((p: any) => p.code === code), code + ": " + JSON.stringify(done));
    }
    assert.ok(done.problems.some((p: any) => p.line > 0));
    assert.ok(done.problems.some((p: any) => p.message.includes("external failure") && !("line" in p)));
    assert.equal(done.problems.filter((p: any) => p.code === "unknown_tone").length, 1);
    assert.deepEqual(done.links, ["scribe:missing"]);
    assert.equal(await page.evaluate(() => (window as any).scribe.fail === (window as any).originalFail), true);

    // Capture-mode checks must ignore unavailable shell APIs but still validate local state ops.
    const captureDone = page.waitForResponse(response => response.request().method() === "POST");
    await page.evaluate(() => performance.clearResourceTimings());
    await page.setContent(`<script>
window.__SCRIBE_PROBLEMS__={id:'t_a',token:'capture',capture:true,tones:[],insertLine:0,insertedLines:0};
${PAGE_PROBLEM_JS}
window.scribe={state:{},update:function(){},ops:{apply:function(state,ops){if(!Array.isArray(ops))throw new Error('ops must be an array');if(ops[0]==='bad')throw new Error('invalid ops')}},file:{read:function(){return Promise.resolve({ok:false,error:'no_board'})}},plugin:function(){return {call:function(){return Promise.resolve({ok:false,error:'capture'})}}}};
window.__scribeWatchProblems();
scribe.file.read();scribe.plugin('test').call();scribe.update({op:'set',path:'x',value:1});try{scribe.update('bad')}catch(e){}
</script>`);
    await captureDone;
    const captured = posts.find(p => p.token === "capture");
    assert.deepEqual(captured.problems, [{code: "bridge_error", message: "scribe.update: invalid ops"}]);
  } finally { await browser.close(); }
});
