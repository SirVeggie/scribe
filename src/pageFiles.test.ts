import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PageFileError, deletePageFile, listPageFolder, readPageFile, resolvePageFile, writePageFile } from "./pageFiles.js";
import type { PermissionGrant } from "./pagePermissions.js";

const grants = (folders: { path: string; approval: string }[]) =>
  new Map<string, PermissionGrant>([["files", { value: "ask", folders, updatedAt: 1 }]]);

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as PageFileError).code;
  }
  return "ok";
};

test("page files stay inside approved folders at their access (#882)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-files-"));
  const images = path.join(root, "images");
  const notes = path.join(root, "notes");
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "a.txt"), "hello");
  const allowed = grants([{ path: images, approval: "write" }, { path: notes, approval: "read" }]);

  // Write only: save, append and delete, but never read or list.
  const shot = resolvePageFile(allowed, path.join(images, "2026", "shot.png"), "write");
  writePageFile(shot, Buffer.from("png"));
  writePageFile(shot, Buffer.from("!"), { append: true });
  assert.equal(fs.readFileSync(shot, "utf8"), "png!");
  assert.equal(code(() => writePageFile(shot, Buffer.from("x"), { overwrite: false })), "exists");
  assert.equal(code(() => resolvePageFile(allowed, shot, "read")), "permission");
  assert.equal(code(() => resolvePageFile(allowed, images, "list")), "permission");

  // Read only: read and list, never write.
  const note = resolvePageFile(allowed, path.join(notes, "a.txt"), "read");
  assert.equal(readPageFile(note, 100).toString(), "hello");
  assert.equal(code(() => readPageFile(note, 2)), "too_large");
  assert.deepEqual(listPageFolder(resolvePageFile(allowed, notes, "list")).map((e) => [e.name, e.kind]), [["a.txt", "file"]]);
  assert.equal(code(() => resolvePageFile(allowed, path.join(notes, "b.txt"), "write")), "permission");

  // Outside, relative, and the approved folder itself.
  assert.equal(code(() => resolvePageFile(allowed, path.join(images, "..", "secret.txt"), "write")), "permission");
  assert.equal(code(() => resolvePageFile(allowed, "images/x.png", "write")), "invalid_path");
  assert.equal(code(() => resolvePageFile(allowed, images, "delete")), "invalid_path");
  assert.equal(code(() => resolvePageFile(new Map([["files", { value: "deny", updatedAt: 1 }]]), shot, "read")), "denied");

  deletePageFile(resolvePageFile(allowed, shot, "delete"));
  assert.equal(fs.existsSync(shot), false);
});

test("a link inside an approved folder cannot lead out of it (#882)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-files-link-"));
  const open = path.join(root, "open");
  const secret = path.join(root, "secret");
  fs.mkdirSync(open);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "key.txt"), "secret");
  try {
    fs.symlinkSync(secret, path.join(open, "out"), "junction");
  } catch {
    t.skip("cannot make a link here");
    return;
  }
  const allowed = grants([{ path: open, approval: "readwrite" }]);
  assert.equal(code(() => resolvePageFile(allowed, path.join(open, "out", "key.txt"), "read")), "denied");
  assert.equal(code(() => resolvePageFile(allowed, path.join(open, "out", "new.txt"), "write")), "denied");
});
