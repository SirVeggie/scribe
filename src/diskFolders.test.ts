import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { runInNewContext } from "node:vm";
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
  const named = store.createFile({ file: path.join(work, "Chosen", "notes.md"), remember: true, activate: false });
  assert.equal(named.title, "notes.md");
  assert.equal(store.fileSettings().defaultLocation, path.join(work, "Chosen"));
  assert.equal(fs.readFileSync(named.file!.path, "utf8"), "");
  store.closeDb();
});

test("new file picker names every file type before creation and cancellation creates nothing", async () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("  async function createFile(kind, folderId) {"), app.indexOf("  /** The HTTP reply and the WebSocket upsert race"));
  for (const kind of ["md", "txt", "other"]) {
    const picks: any[] = [];
    const posts: any[] = [];
    const focused: string[] = [];
    let chosen: string | null = null;
    let exists = false;
    const create = runInNewContext(`${source}\ncreateFile`, {
      NEW_FILE_NAMES: { md: "Untitled.md", txt: "Untitled.txt" },
      window: { scribeChat: { pickWorkspace: async (start: string, options: any) => { picks.push({ start, options }); return chosen; } } },
      newFileTarget: () => ({ folderId: "notes", location: "C:\\Notes" }),
      postNewFile: async (body: any) => {
        posts.push(body);
        if (exists) { exists = false; chosen = null; return { res: { status: 409 }, data: { exists: body.file } }; }
        return { res: { ok: true }, data: { tab: { id: "created" } } };
      },
      showNotice() {}, loadFileSettings() {}, focusWhenOpened: (id: string) => focused.push(id),
    });
    await create(kind, "notes");
    assert.equal(posts.length, 0);
    assert.equal(focused.length, 0);
    assert.equal(picks[0].start, `C:\\Notes\\Untitled.${kind === "md" ? "md" : "txt"}`);
    assert.equal(picks[0].options.files, "save");
    chosen = "C:\\Notes\\Chosen.md";
    await create(kind, "notes");
    assert.equal(posts[0].file, chosen);
    assert.equal(posts[0].folderId, "notes");
    assert.deepEqual(focused, ["created"]);
    exists = true;
    await create(kind, "notes");
    assert.equal(picks.at(-1).start, chosen ?? "C:\\Notes\\Chosen.md");
    assert.equal(posts.length, 2, "an existing name returns to the picker without another creation after cancel");
    assert.deepEqual(focused, ["created"]);
  }
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

test("deleted disk files survive reload and restore with their pages", () => {
  let store = loaded();
  const file = write(path.join(work, "note.md"), "retained bytes");
  const tab = store.openFilePage({ path: file }).tab;
  store.deletePermanent(tab.id, { parkFiles: [tab.id] });
  const parked = tab.file!.trashed!;
  assert.ok(parked.endsWith(".deleted"));
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(parked, "utf8"), "retained bytes");
  store.closeDb();
  store = loaded();
  try {
    store.restoreLast();
    assert.equal(fs.readFileSync(file, "utf8"), "retained bytes");
    assert.equal(fs.existsSync(parked), false);
    assert.equal(store.get(tab.id)?.file?.trashed, undefined);
  } finally { store.closeDb(); }
});

test("restore conflicts leave the page and retained file in Trash for retry", () => {
  const store = loaded();
  try {
    const file = write(path.join(work, "note.md"), "old");
    const tab = store.openFilePage({ path: file }).tab;
    store.deletePermanent(tab.id, { parkFiles: [tab.id] });
    const parked = tab.file!.trashed!;
    write(file, "replacement");
    assert.throws(() => store.restoreLast(), FileExistsError);
    assert.equal(store.get(tab.id), undefined);
    assert.equal(fs.readFileSync(file, "utf8"), "replacement");
    assert.equal(fs.readFileSync(parked, "utf8"), "old");
    assert.throws(() => store.restoreFromTrash(tab.id), FileExistsError);
    fs.unlinkSync(file);
    store.restoreFromTrash(tab.id);
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    assert.ok(store.get(tab.id));
  } finally { store.closeDb(); }
});

test("restore tolerates a completed disk restore whose SQLite update was interrupted", () => {
  let store = loaded();
  const file = write(path.join(work, "note.md"), "old");
  const tab = store.openFilePage({ path: file }).tab;
  store.deletePermanent(tab.id, { parkFiles: [tab.id] });
  fs.renameSync(tab.file!.trashed!, file);
  store.closeDb();
  store = loaded();
  try {
    store.restoreFromTrash(tab.id);
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    assert.equal(store.get(tab.id)?.file?.trashed, undefined);
  } finally { store.closeDb(); }
});

test("a removed retained file restores as a missing file page without blocking Undo", () => {
  const store = loaded();
  try {
    const file = write(path.join(work, "gone.md"), "gone");
    const tab = store.openFilePage({ path: file }).tab;
    store.deletePermanent(tab.id, { parkFiles: [tab.id] });
    fs.unlinkSync(tab.file!.trashed!);
    store.restoreLast();
    assert.equal(store.get(tab.id)?.file?.path, file);
    assert.equal(store.get(tab.id)?.file?.trashed, undefined);
    assert.equal(fs.existsSync(file), false);
  } finally { store.closeDb(); }
});

test("startup recovers a file parked before the page delete was persisted", () => {
  let store = loaded();
  const file = write(path.join(work, "note.md"), "crash recovery");
  const tab = store.openFilePage({ path: file }).tab;
  store.persist();
  const parked = path.join(work, `.${path.basename(file)}.${tab.id}.deleted`);
  fs.renameSync(file, parked);
  store.closeDb();
  store = loaded();
  try {
    assert.equal(fs.readFileSync(file, "utf8"), "crash recovery");
    assert.equal(fs.existsSync(parked), false);
    assert.ok(store.get(tab.id));
  } finally { store.closeDb(); }
});

test("bulk file deletion rolls back earlier moves if a later rename fails", () => {
  const store = loaded();
  try {
    const a = write(path.join(work, "a.md"), "a");
    const b = write(path.join(work, "b.md"), "b");
    const tabs = [a, b].map((file) => store.openFilePage({ path: file }).tab);
    const ids = tabs.map((tab) => tab.id);
    const rename = fs.renameSync;
    const stub = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (from === b) throw new Error("locked file");
      return rename(from, to);
    });
    try { assert.throws(() => store.deleteMany(ids, [], { parkFiles: ids }), /locked file/); }
    finally { stub.mock.restore(); }
    for (const tab of tabs) {
      assert.ok(store.get(tab.id));
      assert.equal(tab.file!.trashed, undefined);
      assert.ok(fs.existsSync(tab.file!.path));
    }
    assert.deepEqual(fs.readdirSync(work).sort(), ["a.md", "b.md"]);
  } finally { store.closeDb(); }
});

test("watcher events and rescans do not turn retained files into new or renamed pages", () => {
  const store = loaded();
  try {
    const file = write(path.join(work, "a.md"), "a");
    store.openDiskFolder(work, null);
    const tab = store.findFilePage(file)!;
    store.deletePermanent(tab.id, { parkFiles: [tab.id] });
    const parked = tab.file!.trashed!;
    const other = write(path.join(work, "b.md"), "b");
    store.diskChanged([file, other]);
    store.rescanDisk(work);
    assert.equal(tab.file!.path, file);
    assert.equal(tab.file!.trashed, parked);
    assert.ok(store.findFilePage(other));
    assert.equal(store.findFilePage(parked), undefined);
    store.restoreFromTrash(tab.id);
    assert.equal(fs.readFileSync(file, "utf8"), "a");
  } finally { store.closeDb(); }
});

test("purging removes only the retained file, while keeping a replacement and kept files", () => {
  const store = loaded();
  try {
    const a = write(path.join(work, "a.md"), "a");
    const b = write(path.join(work, "b.md"), "b");
    const first = store.openFilePage({ path: a }).tab;
    const second = store.openFilePage({ path: b }).tab;
    store.deleteMany([first.id, second.id], [], { parkFiles: [first.id] });
    const parked = first.file!.trashed!;
    write(a, "replacement");
    store.purgeFromTrash(first.id);
    assert.equal(fs.existsSync(parked), false);
    assert.equal(fs.readFileSync(a, "utf8"), "replacement");
    store.emptyTrash();
    assert.equal(fs.readFileSync(b, "utf8"), "b");
  } finally { store.closeDb(); }
});

test("Trash expiry also removes retained disk files", () => {
  const store = loaded();
  try {
    const file = write(path.join(work, "old.md"), "old");
    const tab = store.openFilePage({ path: file }).tab;
    const now = Date.now();
    store.deletePermanent(tab.id, { parkFiles: [tab.id] });
    const batches = (store as unknown as { deleted: Array<{ deletedAt: number }> }).deleted;
    batches[batches.length - 1].deletedAt = now - 40 * 24 * 60 * 60 * 1000;
    const parked = tab.file!.trashed!;
    store.deleteMany([store.upsert({ title: "Trigger expiry", html: "<p>x</p>" }).tab.id]);
    assert.equal(fs.existsSync(parked), false);
  } finally { store.closeDb(); }
});
