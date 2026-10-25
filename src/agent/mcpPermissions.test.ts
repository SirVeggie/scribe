import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { McpPermissions, mcpApprovalOptions } from "./mcpPermissions.js";
import { resolveServer } from "./mcpConfig.js";

test("MCP grants persist with the requested tool and thread scopes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-permissions-"));
  try {
    const file = path.join(dir, "permissions.json");
    const permissions = new McpPermissions(file);
    const server = resolveServer("echo", "global", { command: "node", args: ["echo.js"] })!;
    assert.deepEqual(mcpApprovalOptions.map((o) => o.label), ["Allow once", "Allow this server for this thread", "Always allow this tool", "Deny"]);
    assert.equal(permissions.grant(server, "read", "a", "allow"), true);
    assert.equal(permissions.allows(server, "read", "a"), false);
    assert.equal(permissions.grant(server, "read", "a", "reject"), false);
    assert.equal(permissions.grant(server, "read", "a", "mcp"), true);
    const reopened = new McpPermissions(file);
    assert.equal(reopened.allows(server, "write", "a"), true);
    assert.equal(reopened.allows(server, "read", "b"), false);
    assert.equal(reopened.grant(server, "read", "a", "whitelist"), true);
    assert.equal(new McpPermissions(file).allows(server, "read", "b"), true);
    assert.equal(reopened.allows(server, "write", "b"), false);
    assert.equal(reopened.allows({ ...server, args: ["different.js"] }, "read", "a"), false);
    assert.equal(reopened.allows({ ...server, name: "other" }, "read", "a"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saved grants can be inspected, revoked individually and pruned without losing other scopes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-revoke-"));
  try {
    const file = path.join(dir, "permissions.json");
    const permissions = new McpPermissions(file);
    const server = resolveServer("echo", "global", { command: "node", env: { SECRET: "never display" } })!;
    permissions.grant(server, "read:all", "a", "whitelist");
    permissions.grant(server, "write", "a", "whitelist");
    permissions.grant(server, "read", "a", "mcp");
    permissions.grant(server, "read", "deleted", "mcp");
    const grants = permissions.list();
    assert.equal(grants.length, 4);
    assert.deepEqual(grants[0].server, { name: "echo", layer: "global" });
    assert.doesNotMatch(JSON.stringify(grants), /never display/);
    permissions.revoke(grants[0].key, "read:all");
    assert.equal(new McpPermissions(file).allows(server, "read:all", "b"), false);
    assert.equal(permissions.allows(server, "write", "b"), true);
    assert.equal(permissions.allows(server, "read:all", "a"), true);
    permissions.pruneThreads(["a"]);
    assert.equal(permissions.allows(server, "other", "deleted"), false);
    permissions.revoke(grants[0].key, undefined, "a");
    assert.equal(permissions.allows(server, "other", "a"), false);
    // Old files have hashes alone; match current configs, retain unknown grants for removal.
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    delete saved.servers;
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal(permissions.list()[0].server, null);
    assert.equal(permissions.list([server])[0].server?.name, "echo");
    permissions.revoke(grants[0].key, "write");
    assert.deepEqual(new McpPermissions(file).list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
