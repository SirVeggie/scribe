import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginSecrets } from "./secrets.js";

test("non-Windows secrets are AES-sealed with a recorded key store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-secrets-"));
  try {
    const secrets = new PluginSecrets(root, { platform: "linux", stores: ["file"] });
    await secrets.set("p", "token", "hunter2-secret");
    assert.equal(fs.readFileSync(path.join(root, "p.token.secret"), "utf8").includes("hunter2"), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "key.json"), "utf8")), { store: "file" });
    assert.equal(await new PluginSecrets(root, { platform: "linux", stores: ["file"] }).get("p", "token"), "hunter2-secret");
    // A lost key fails loudly instead of quietly making a new one.
    fs.rmSync(path.join(root, "master.key"));
    await assert.rejects(new PluginSecrets(root, { platform: "linux" }).get("p", "token"), /not available from key file/);
    await assert.rejects(new PluginSecrets(root, { platform: "linux" }).set("p", "other", "x"), /not available/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
