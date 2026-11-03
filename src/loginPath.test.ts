import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLoginPath, mergePath } from "./loginPath.js";

test("mergePath keeps the current PATH first and adds only missing folders", () => {
  assert.equal(mergePath("/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin", "", "/usr/local/bin"]), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(mergePath("", ["/a", "/a"]), "/a");
});

test("adoptLoginPath leaves PATH alone off macOS", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  adoptLoginPath("linux", env);
  assert.equal(env.PATH, "/usr/bin");
});
