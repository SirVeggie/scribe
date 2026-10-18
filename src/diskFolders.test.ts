import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DiskLinkTakenError, FileExistsError, NeedsLocationError, uniqueFileName, watchRoots, within } from "./diskFolders.js";
import { BoardStore } from "./store.js";

let dir = "";
let work = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SCRIBE_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-disk-"));
  process.env.SCRIBE_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.SCRIBE_HOME;
  } else {
    process.env.SCRIBE_HOME = prevHome;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function loaded(): BoardStore {
  const store = new BoardStore();
  store.load();
  return store;
}

function write(file: string, content = ""): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test("watchRoots keeps one root for equal and nested disk folders", () => {
  const a = path.join(work, "notes");
  const roots = watchRoots([path.join(a, "sub"), a, `${a}${path.sep}`, path.join(work, "other")]);
  assert.deepEqual(roots.sort(), [a, path.join(work, "other")].sort());
  assert.equal(within(a, path.join(a, "x", "y")), true);
  assert.equal(within(a, a), true);
  assert.equal(within(a, `${a}-2`), false);
  assert.equal(within(path.join(a, "sub"), a), false);
});

test("uniqueFileName counts up past taken names", () => {
  write(path.join(work, "Untitled.md"));
  write(path.join(work, "Untitled 2.md"));
  assert.equal(uniqueFileName(work, "Untitled.md"), path.join(work, "Untitled 3.md"));
  assert.equal(uniqueFileName(work, "fresh.txt"), path.join(work, "fresh.txt"));
});

test("subfolders inherit their parent's disk location by name, and keep it when renamed or moved", () => {
  const store = loaded();
  const root = path.join(work, "Notes");
  fs.mkdirSync(root);
  const notes = store.createFolder({ name: "Notes" });
  store.setFolderDisk(notes.id, root);
  const ideas = store.createFolder({ name: "Ideas", parentId: notes.id });
  assert.equal(store.folderDiskPath(ideas.id), path.join(root, "Ideas"));
  assert.equal(store.folderDiskPath(store.createFolder({ name: "Plain" }).id), null);

  // Not on disk yet: a rename just follows the name.
  store.renameFolder(ideas.id, "Thoughts");
  assert.equal(store.folderDiskPath(ideas.id), path.join(root, "Thoughts"));
  assert.equal(store.listFolders().find((f) => f.id === ideas.id)?.disk, undefined);

  // On disk: the folder keeps its disk folder as an explicit link.
  fs.mkdirSync(path.join(root, "Thoughts"));
  store.renameFolder(ideas.id, "Renamed");
  assert.equal(store.folderDiskPath(ideas.id), path.join(root, "Thoughts"));
  store.moveFolder(ideas.id, null, 0);
  assert.equal(store.folderDiskPath(ideas.id), path.join(root, "Thoughts"));
  store.closeDb();
});

test("a disk folder links to one Library folder only, and the link survives a reload", () => {
  const store = loaded();
  const root = path.join(work, "Notes");
  fs.mkdirSync(path.join(root, "Sub"), { recursive: true });
  const a = store.createFolder({ name: "Notes" });
  store.setFolderDisk(a.id, root);
  const b = store.createFolder({ name: "Other" });
  assert.throws(() => store.setFolderDisk(b.id, root), (err) => err instanceof DiskLinkTakenError && err.folderId === a.id);
  const sub = store.createFolder({ name: "Sub", parentId: a.id });
  assert.throws(() => store.setFolderDisk(b.id, path.join(root, "Sub")), (err) => err instanceof DiskLinkTakenError && err.folderId === sub.id);
  assert.throws(() => store.setFolderDisk(b.id, path.join(work, "missing")), /folder not found/);
  store.persist();
  store.closeDb();

  const again = loaded();
  assert.equal(again.listFolders().find((f) => f.id === a.id)?.disk, root);
  assert.equal(again.folderDiskPath(sub.id), path.join(root, "Sub"));
  again.closeDb();
});

test("createFile puts the file in the folder's disk location, else the default, else asks", () => {
  const store = loaded();
  const root = path.join(work, "Notes");
  fs.mkdirSync(root);
  const notes = store.createFolder({ name: "Notes" });
  store.setFolderDisk(notes.id, root);
  const sub = store.createFolder({ name: "Deep", parentId: notes.id });

  const first = store.createFile({ folderId: sub.id, name: "Untitled.md", activate: false });
  assert.equal(first.file?.path, path.join(root, "Deep", "Untitled.md"));
  assert.equal(first.folderId, sub.id);
  assert.equal(fs.readFileSync(first.file!.path, "utf8"), "");
  const second = store.createFile({ folderId: sub.id, name: "Untitled.md", activate: false });
  assert.equal(second.file?.path, path.join(root, "Deep", "Untitled 2.md"));

  const plain = store.createFolder({ name: "Plain" });
  assert.throws(() => store.createFile({ folderId: plain.id, name: "a.txt" }), (err) => err instanceof NeedsLocationError);
  const inbox = path.join(work, "Inbox");
  const picked = store.createFile({ folderId: plain.id, name: "a.txt", location: inbox, remember: true, activate: false });
  assert.equal(picked.file?.path, path.join(inbox, "a.txt"));
  assert.equal(picked.folderId, plain.id, "the page stays in the plain folder");
  assert.equal(store.fileSettings().defaultLocation, inbox);
  const next = store.createFile({ folderId: null, name: "a.txt", activate: false });
  assert.equal(next.file?.path, path.join(inbox, "a 2.txt"));

  assert.throws(() => store.createFile({ file: next.file!.path }), (err) => err instanceof FileExistsError);
  store.closeDb();
});

test("moving a file page into a disk folder moves its file; out to a plain folder it stays", () => {
  const store = loaded();
  const root = path.join(work, "Notes");
  fs.mkdirSync(root);
  const notes = store.createFolder({ name: "Notes" });
  store.setFolderDisk(notes.id, root);
  const plain = store.createFolder({ name: "Plain" });
  const loose = write(path.join(work, "loose.md"), "# hi\n");
  const { tab } = store.openFilePage({ path: loose, activate: false });

  store.moveFileWithPage(tab.id, notes.id);
  const moved = path.join(root, "loose.md");
  assert.equal(store.get(tab.id)?.file?.path, moved);
  assert.equal(fs.existsSync(loose), false);
  assert.equal(fs.readFileSync(moved, "utf8"), "# hi\n");

  store.moveFileWithPage(tab.id, plain.id);
  assert.equal(store.get(tab.id)?.file?.path, moved, "a plain folder leaves the file where it is");

  // A name already there: refused, or kept both.
  const other = write(path.join(work, "loose.md"), "other\n");
  const second = store.openFilePage({ path: other, activate: false }).tab;
  assert.throws(() => store.moveFileWithPage(second.id, notes.id), (err) => err instanceof FileExistsError);
  store.moveFileWithPage(second.id, notes.id, { keepBoth: true });
  assert.equal(store.get(second.id)?.file?.path, path.join(root, "loose 2.md"));
  assert.equal(store.get(second.id)?.title, "loose 2.md");

  // A dropped copy becomes a real file.
  const copy = store.openFilePage({ name: "dropped.txt", bytes: Buffer.from("bytes") }).tab;
  store.moveFileWithPage(copy.id, notes.id);
  const real = store.get(copy.id)?.file;
  assert.equal(real?.path, path.join(root, "dropped.txt"));
  assert.equal(real?.copy, undefined);
  assert.equal(fs.readFileSync(real!.path, "utf8"), "bytes");
  store.closeDb();
});

test("files added on disk get pages in the matching Library folder; renames keep the page", () => {
  const store = loaded();
  const root = path.join(work, "Notes");
  write(path.join(root, "a.md"), "a");
  const { folder } = store.openDiskFolder(root, null);
  assert.equal(folder.disk, root);
  const page = store.findFilePage(path.join(root, "a.md"))!;

  const nested = write(path.join(root, "new", "deeper", "b.md"), "b");
  const top = write(path.join(root, "c.txt"), "c");
  store.diskChanged([nested, top]);
  const deeper = store.listFolders().find((f) => f.name === "deeper");
  assert.ok(deeper, "subfolders are made for new disk folders");
  assert.equal(store.folderDiskPath(deeper.id), path.dirname(nested));
  assert.equal(store.findFilePage(nested)?.folderId, deeper.id);
  assert.equal(store.findFilePage(top)?.folderId, folder.id);

  // The same events again change nothing.
  const before = [store.findFilePage(nested)?.id, store.findFilePage(top)?.id, store.listFolders().length];
  store.diskChanged([nested, top]);
  assert.deepEqual([store.findFilePage(nested)?.id, store.findFilePage(top)?.id, store.listFolders().length], before);

  fs.renameSync(path.join(root, "a.md"), path.join(root, "renamed.md"));
  store.diskChanged([path.join(root, "a.md"), path.join(root, "renamed.md")]);
  assert.equal(store.get(page.id)?.file?.path, path.join(root, "renamed.md"));
  assert.equal(store.findFilePage(path.join(root, "renamed.md"))?.id, page.id);

  // Opening the same disk folder again updates the linked folder instead of making another.
  write(path.join(root, "d.md"), "d");
  const again = store.openDiskFolder(root, null);
  assert.equal(again.folder.id, folder.id);
  assert.equal(again.pages, 1);
  assert.equal(store.listFolders().filter((f) => f.name === "Notes").length, 1);
  store.closeDb();
});

test("the watcher turns a file written on disk into a page", async () => {
  const store = loaded();
  const root = path.join(work, "Watched");
  fs.mkdirSync(root);
  const folder = store.createFolder({ name: "Watched" });
  store.setFolderDisk(folder.id, root);
  const watcher = store.watchDisk();
  try {
    const file = write(path.join(root, "fresh.md"), "x");
    const deadline = Date.now() + 5000;
    while (!store.findFilePage(file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      watcher.flush();
    }
    assert.equal(store.findFilePage(file)?.folderId, folder.id);
  } finally {
    store.stopDiskWatch();
    store.closeDb();
  }
});
