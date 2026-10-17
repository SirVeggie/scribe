import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launchChromium } from "./chromium.js";
import { allowCaptureFraming, captureFrameHeaders } from "./captureFraming.js";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { pageOrigin } from "./config.js";
import {
  beginCaptureBoot,
  captureBootOf,
  endCaptureBoot,
  parseScreenshotLocal,
  readCaptureBoot,
  screenshotHttpStatus,
  screenshotUrl,
} from "./screenshot.js";

test("parseScreenshotLocal accepts a plain object and rejects junk", () => {
  assert.equal(parseScreenshotLocal(undefined), undefined);
  assert.deepEqual(parseScreenshotLocal({ view: "expanded" }), { view: "expanded" });
  assert.throws(() => parseScreenshotLocal("x"), /local must be a JSON object/);
  assert.throws(() => parseScreenshotLocal([]), /local must be a JSON object/);
  assert.throws(() => parseScreenshotLocal({ big: "x".repeat(70 * 1024) }), /local is too large/);
});

test("screenshotUrl loads embed pages at the embedded URL", () => {
  const tab = {
    id: "t_abc",
    html: `<!DOCTYPE html><html><head><meta name="scribe-embed" content="http://127.0.0.1:8188/"></head><body></body></html>`,
  };
  assert.equal(screenshotUrl(tab), "http://127.0.0.1:8188/");
  assert.equal(screenshotUrl(tab, "deadbeef0123"), "http://127.0.0.1:8188/");
});

test("screenshotUrl points ordinary pages at /view/:id, with a shot query when seeded", () => {
  const tab = { id: "t_abc", html: "<p>hi</p>" };
  // Each page on its own origin (#660).
  assert.equal(screenshotUrl(tab), `${pageOrigin("t_abc")}/view/t_abc`);
  assert.equal(screenshotUrl(tab, "deadbeef0123"), `${pageOrigin("t_abc")}/view/t_abc?shot=deadbeef0123`);
});

test("capture boot is readable until ended, and junk ids miss", () => {
  const id = beginCaptureBoot({ view: "idle" });
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.deepEqual(readCaptureBoot(id), { local: { view: "idle" } });
  assert.deepEqual(captureBootOf(id), { local: { view: "idle" } });
  assert.equal(captureBootOf("not-a-shot"), undefined);
  assert.equal(captureBootOf(1), undefined);
  endCaptureBoot(id);
  assert.equal(readCaptureBoot(id), undefined);
});

test("screenshotHttpStatus maps local and click errors to 400", () => {
  assert.equal(screenshotHttpStatus("tab not found: x"), 404);
  assert.equal(screenshotHttpStatus("selector not found: .x"), 400);
  assert.equal(screenshotHttpStatus("click selector not found: .x"), 400);
  assert.equal(screenshotHttpStatus("click selector is not visible: .x"), 400);
  assert.equal(screenshotHttpStatus("local must be a JSON object"), 400);
  assert.equal(screenshotHttpStatus("local is too large (max 65536 bytes)"), 400);
  assert.equal(screenshotHttpStatus("local and fromViewer do not apply to embed pages; the capture loads the embedded URL directly"), 400);
});

test("capture framing removes only embedding restrictions from all enforced policies", () => {
  assert.deepEqual(captureFrameHeaders({
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; script-src 'self', FRAME-ANCESTORS 'self'",
    "content-security-policy-report-only": "frame-ancestors 'none'",
    "set-cookie": "session=test",
  }), {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'",
    "content-security-policy-report-only": "frame-ancestors 'none'",
    "set-cookie": "session=test",
  });
  assert.deepEqual(captureFrameHeaders({ "content-security-policy": "frame-ancestors 'self';" }), {});
});

test("capture context renders blocked nested frames and bridge clicks stay read-only", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/inner", "set-cookie": "capture=test; Path=/" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'; script-src 'unsafe-inline'",
    });
    res.end(req.url === "/outer"
      ? '<iframe src="/redirect"></iframe>'
      : '<p>Nested frame loaded</p><script>window.loaded = true</script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser;
  try {
    browser = await launchChromium({ headless: true, args: [], purpose: "capture test" });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await allowCaptureFraming(context);
    const page = await context.newPage();
    await page.goto(base + "/outer");
    await page.frameLocator("iframe").locator("p").waitFor({ timeout: 5000 });
    assert.equal(await page.frameLocator("iframe").locator("p").textContent(), "Nested frame loaded");
    assert.equal(await page.frames()[1].evaluate(() => (window as any).loaded), true);
    assert.match(await page.frames()[1].evaluate(() => document.cookie), /capture=test/);
    // The ordinary browser still enforces those headers.
    const ordinary = await browser.newPage();
    await ordinary.goto(base + "/outer");
    assert.equal(await ordinary.frames()[1].evaluate(() => (window as any).loaded), undefined);
    await ordinary.close();

    for (const bootCapture of [true, false]) {
      await page.goto(base + "/inner");
      await page.evaluate(capture => {
        (window as any).__SCRIBE_BOOT__ = { id: "t_test", state: { count: 1 }, local: { view: "start" }, viewer: "test", capture };
        (window as any).__SCRIBE_CAPTURE__ = !capture;
        (window as any).writes = [];
        window.fetch = ((url: string) => {
          (window as any).writes.push(url);
          return Promise.resolve(new Response('{}'));
        }) as any;
      }, bootCapture);
      await page.addScriptTag({ content: BOARD_BRIDGE_JS });
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Capture click";
        button.onclick = () => {
          const s = (window as any).scribe;
          s.set({ count: 2 });
          s.update({ op: "set", path: "count", value: 3 });
          s.signal("changed");
          (window as any).actionResult = s.action("create");
          s.setLocal({ view: "clicked" });
          s.flush();
        };
        document.body.append(button);
      });
      await page.getByRole("button", { name: "Capture click" }).click();
      assert.equal(await page.evaluate(() => (window as any).actionResult), undefined);
      await page.waitForTimeout(350);
      assert.deepEqual(await page.evaluate(() => ({ state: (window as any).scribe.state, local: (window as any).scribe.local, writes: (window as any).writes })), {
        state: { count: 1 }, local: { view: "clicked" }, writes: [],
      });
    }
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
