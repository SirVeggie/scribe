import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPermission, normalizeFolders, permissionViews, type PermissionGrant } from "./pagePermissions.js";

const root = path.join(os.tmpdir(), "scribe-perm-root");
const grant = (value: PermissionGrant["value"], folders?: PermissionGrant["folders"]): PermissionGrant => ({ value, ...(folders ? { folders } : {}), updatedAt: 1 });

test("permissions without a grant are at their defaults", () => {
  const none = new Map<string, PermissionGrant>();
  assert.equal(checkPermission(none, { perm: "agent.chat" }), "allow");
  assert.equal(checkPermission(none, { perm: "agent.unattended" }), "ask");
  assert.equal(checkPermission(none, { perm: "agent.workspace", folder: root }), "ask");
  assert.equal(checkPermission(none, { perm: "plugin.unknown" }), "deny");
  const views = permissionViews(none);
  assert.deepEqual(
    views.map((v) => [v.id, v.value]),
    [
      ["audio.microphone", "ask"],
      ["audio.microphoneStream", "ask"],
      ["audio.transcribe", "ask"],
      ["agent.chat", "allow"],
      ["agent.unattended", "ask"],
      ["agent.workspace", "ask"],
      ["files", "ask"],
      ["ml.decide", "ask"],
    ]
  );
  assert.deepEqual(views.find((v) => v.id === "agent.workspace")?.folders, []);
});

test("live microphone requires its own permission and accepts allow, deny and ask", () => {
  const need = { perm: "audio.microphoneStream" };
  assert.equal(checkPermission(new Map([["audio.microphone", grant("allow")]]), need), "ask");
  for (const value of ["allow", "deny", "ask"] as const) {
    assert.equal(checkPermission(new Map([[need.perm, grant(value)]]), need), value);
  }
  assert.equal(permissionViews(new Map()).find(p => p.id === need.perm)?.risky, true);
});

test("a folder grant covers its subfolders up to its approval", () => {
  const grants = new Map([["agent.workspace", grant("ask", [{ path: root, approval: "edits" }])]]);
  const need = (folder: string, approval?: string) => checkPermission(grants, { perm: "agent.workspace", folder, approval });
  assert.equal(need(root), "allow");
  assert.equal(need(path.join(root, "sub", "deeper"), "edits"), "allow");
  assert.equal(need(path.join(root, "sub"), "auto"), "ask");
  assert.equal(need(root + "-other"), "ask");
  assert.equal(need(path.dirname(root)), "ask");
  assert.equal(need("relative/path"), "deny");
  assert.equal(checkPermission(grants, { perm: "agent.workspace" }), "deny");
  if (process.platform === "win32") {
    assert.equal(need(root.toUpperCase()), "allow");
  }
  grants.set("agent.workspace", grant("deny", [{ path: root, approval: "full" }]));
  assert.equal(need(root), "deny");
});

test("folder grants from input are absolute, normalized, and one per folder", () => {
  const folders = normalizeFolders([
    { path: path.join(root, "a", ".."), approval: "auto" },
    { path: root, approval: "full" },
    { path: "relative", approval: "full" },
    { path: path.join(root, "b"), approval: "bogus" },
    "nope",
  ]);
  assert.deepEqual(folders, [
    { path: path.resolve(root), approval: "full" },
    // An unknown rung is the lowest one.
    { path: path.join(root, "b"), approval: "readonly" },
  ]);
});

test("files folders are granted at read, write, or read & write, and read & write covers both (#882)", () => {
  const grants = new Map([["files", grant("ask", [
    { path: path.join(root, "both"), approval: "readwrite" },
    { path: path.join(root, "logs"), approval: "write" },
    { path: path.join(root, "docs"), approval: "read" },
  ])]]);
  const need = (folder: string, approval: string) => checkPermission(grants, { perm: "files", folder: path.join(root, folder), approval });
  assert.equal(need("both/a.png", "read"), "allow");
  assert.equal(need("both/a.png", "write"), "allow");
  assert.equal(need("logs/today.log", "write"), "allow");
  assert.equal(need("logs/today.log", "read"), "ask");
  assert.equal(need("docs/x.md", "read"), "allow");
  assert.equal(need("docs/x.md", "write"), "ask");
  assert.equal(need("elsewhere/x.md", "read"), "ask");
  assert.deepEqual(
    normalizeFolders([{ path: root, approval: "edits" }, { path: path.join(root, "w"), approval: "write" }], permissionViews(new Map()).find((p) => p.id === "files")),
    [{ path: root, approval: "read" }, { path: path.join(root, "w"), approval: "write" }]
  );
  const view = permissionViews(new Map()).find((p) => p.id === "files");
  assert.equal(view?.risky, true);
  assert.deepEqual(view?.levels?.map((l) => l.id), ["read", "write", "readwrite"]);
});
