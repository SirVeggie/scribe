import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlErrorText } from "./pageText.js";

test("htmlErrorText reads an HTML error page as its text (#1053)", () => {
  const page = `<!doctype html><meta charset="utf-8"><title>Embed</title><body style="font:14px system-ui;background:#1a1a1d;color:#e8e8ea;padding:40px"><p>CarrotBox is not connected right now. This embed runs there.</p></body>`;
  assert.equal(htmlErrorText(page), "CarrotBox is not connected right now. This embed runs there.");
  assert.equal(htmlErrorText("Request failed: <b> is not allowed"), "Request failed: <b> is not allowed");
});
