import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceCodeFromOutput, loginUrlFromOutput } from "./providers/codex.js";
import { printedLoginUrl } from "./providers/claude.js";

// What the CLIs print with no browser, as seen on Linux (#909).
const CODEX_DEVICE = [
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m",
  "",
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m",
  "   \x1b[94mAB12-CD34E\x1b[0m",
  "",
].join("\n");

test("codex --device-auth: the page and the one-time code", () => {
  assert.equal(loginUrlFromOutput(CODEX_DEVICE), "https://auth.openai.com/codex/device");
  assert.equal(deviceCodeFromOutput(CODEX_DEVICE), "AB12-CD34E");
  // The code comes after the page: until it is printed there is none.
  assert.equal(deviceCodeFromOutput(CODEX_DEVICE.slice(0, CODEX_DEVICE.indexOf("2. Enter"))), null);
  assert.equal(deviceCodeFromOutput(CODEX_DEVICE.slice(0, CODEX_DEVICE.indexOf("AB12"))), null);
});

test("claude auth login: the printed URL once its line has ended", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
  const out = `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;
  assert.equal(printedLoginUrl(out), url);
  assert.equal(printedLoginUrl(out.slice(0, out.indexOf("&state"))), null);
  assert.equal(printedLoginUrl("Opening browser to sign in…\n"), null);
});
