import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkEnv } from "./providers/claude.js";

// #1018: the SDK's default "sdk-ts" label costs more of the 5h window; Scribe labels its own traffic.
test("Claude SDK queries are labeled scribe, also over an inherited host label", () => {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
  try {
    assert.equal(sdkEnv().CLAUDE_CODE_ENTRYPOINT, "scribe");
    const acc = sdkEnv("C:/accounts/a");
    assert.equal(acc.CLAUDE_CODE_ENTRYPOINT, "scribe");
    assert.equal(acc.CLAUDE_CONFIG_DIR, "C:/accounts/a");
    assert.equal(acc.CLAUDE_AGENT_SDK_CLIENT_APP, "scribe/1");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
  }
});
