# Browser HTTP fixtures

Use `httpFixture` from `src/test/httpFixture.ts` when a browser test loads a
worker or worklet. In Chromium, `AudioWorklet.addModule()` requests can bypass
Playwright's `page.route()`: mocked pages still need a real server for modules.
Serve JavaScript with a JavaScript Content-Type.

```ts
import { test } from "node:test";
import { httpFixture } from "./test/httpFixture.js";

test("worklet", async t => {
  const { origin } = await httpFixture(t, (req, res) => {
    if (req.url === "/processor.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(processorSource);
    }
    res.writeHead(404);
    res.end();
  });
  // Navigate to this origin, or use page.route for the document and APIs;
  // leave module requests to the server (route.continue() for broad routes).
  // await page.goto(origin);
});
```

The helper binds to `127.0.0.1` on an OS-assigned port and registers teardown
with the test before listening, including when later setup fails. It returns
`origin` and `port`. For a second origin with the same port, pass
`{ host: "127.0.0.2", port }` to another fixture. Close browser instances in
`t.after()` as soon as they launch. See `src/audio/audioUi.test.ts` for a complete
cross-origin audio example, including a worklet load failure.
