import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  FileConflictError,
  kindByName,
  linkedImagePath,
  listFolder,
  looksLikeText,
  readFileBytes,
  readFileForPage,
  samePath,
  scanFolder,
  writeFileText,
  type FileText,
} from "./filePages.js";
import { BoardStore } from "./store.js";
import { editorBundle } from "./editorBundle.js";
import { pathToFileURL } from "node:url";

let dir = "";
let work = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SCRIBE_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-files-"));
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

function write(file: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function asText(info: ReturnType<typeof readFileForPage>): FileText {
  assert.ok("text" in info, `expected text, got ${info.kind}`);
  return info;
}

test("kindByName classifies by extension and known file names", () => {
  assert.deepEqual(kindByName("notes.md"), { kind: "markdown", lang: "markdown" });
  assert.deepEqual(kindByName("package.json"), { kind: "json", lang: "json" });
  assert.deepEqual(kindByName("index.ts"), { kind: "code", lang: "typescript" });
  assert.deepEqual(kindByName("page.HTML"), { kind: "html", lang: "xml" });
  assert.deepEqual(kindByName("logo.png"), { kind: "image" });
  assert.deepEqual(kindByName("Report.PDF"), { kind: "pdf" });
  assert.deepEqual(kindByName("todo.txt"), { kind: "text" });
  assert.deepEqual(kindByName("Dockerfile"), { kind: "code", lang: "dockerfile" });
  assert.deepEqual(kindByName("LICENSE"), { kind: "text" });
});

test("looksLikeText rejects NUL bytes and invalid UTF-8", () => {
  assert.equal(looksLikeText(Buffer.from("héllo wörld\n", "utf8")), true);
  assert.equal(looksLikeText(Buffer.from([0x61, 0x00, 0x62])), false);
  assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd, 0x80])), false);
});

test("CRLF and BOM are read as \\n text and restored exactly on write", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const original = Buffer.concat([bom, Buffer.from("# Title\r\n\r\nbody line\r\n", "utf8")]);
  const file = write(path.join(work, "crlf.md"), original);

  const info = asText(readFileForPage(file));
  assert.equal(info.kind, "markdown");
  assert.equal(info.text, "# Title\n\nbody line\n");
  assert.equal(info.eol, "\r\n");
  assert.equal(info.bom, true);
  assert.equal(info.name, "crlf.md");

  writeFileText(file, info.text, { eol: info.eol, bom: info.bom, expectedMtime: info.mtime });
  assert.deepEqual(fs.readFileSync(file), original);
});

test("writeFileText refuses a file changed on disk unless forced", () => {
  const file = write(path.join(work, "conflict.txt"), "one\n");
  const info = asText(readFileForPage(file));

  assert.throws(
    () => writeFileText(file, "mine\n", { expectedMtime: info.mtime - 10_000 }),
    (err: unknown) => err instanceof FileConflictError && err.mtime === Math.floor(fs.statSync(file).mtimeMs)
  );
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");

  writeFileText(file, "mine\n", { expectedMtime: info.mtime - 10_000, force: true });
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
});

test("writeFileText throws for a missing file unless create is set", () => {
  const missing = path.join(work, "new.txt");
  assert.throws(() => writeFileText(missing, "x"), /file not found/);
  assert.equal(fs.existsSync(missing), false);

  const info = writeFileText(missing, "x", { create: true });
  assert.equal(fs.readFileSync(missing, "utf8"), "x");
  assert.equal(info.name, "new.txt");
});

test("binary files come back unsupported with a reason and no text", () => {
  const file = write(path.join(work, "data.bin"), Buffer.from([0x89, 0x00, 0x01, 0x02, 0x03]));
  const info = readFileForPage(file);
  assert.equal(info.kind, "unsupported");
  assert.ok("reason" in info && info.reason);
  assert.equal("text" in info, false);
});

test("images are returned without text", () => {
  const file = write(path.join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const info = readFileForPage(file);
  assert.equal(info.kind, "image");
  assert.equal("text" in info, false);
});

test("PDFs are returned without text, and their bytes are served as application/pdf", () => {
  const file = write(path.join(work, "paper.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]));
  const info = readFileForPage(file);
  assert.equal(info.kind, "pdf");
  assert.equal("text" in info, false);
  assert.equal(readFileBytes(file).type, "application/pdf");
  assert.throws(() => readFileBytes(write(path.join(work, "notes.txt"), "x")), /not an image or PDF/);
});

test("scanFolder skips dot entries, dependency folders and empty folders", () => {
  const root = path.join(work, "project");
  write(path.join(root, "README.md"), "# hi\n");
  write(path.join(root, "src", "index.ts"), "export {};\n");
  write(path.join(root, "src", "deep", "a.txt"), "a\n");
  write(path.join(root, "node_modules", "dep", "index.js"), "x\n");
  write(path.join(root, ".hidden", "secret.txt"), "s\n");
  write(path.join(root, ".env"), "KEY=1\n");
  fs.mkdirSync(path.join(root, "empty"));

  const { tree, files, truncated } = scanFolder(root);
  assert.equal(tree.name, "project");
  assert.equal(files, 3);
  assert.equal(truncated, false);
  const names = tree.children.map((entry) => entry.name);
  assert.deepEqual(names, ["README.md", "src"]);
  const src = tree.children[1];
  assert.equal(src.kind, "dir");
  assert.deepEqual(src.children.map((entry) => entry.name), ["deep", "index.ts"]);
});

test("listFolder lists the parent when given a file path", () => {
  const folder = path.join(work, "listing");
  const file = write(path.join(folder, "one.md"), "# one\n");
  write(path.join(folder, "two.txt"), "two\n");
  fs.mkdirSync(path.join(folder, "sub"));

  const fromFile = listFolder(file);
  assert.equal(fromFile.exists, true);
  assert.equal(samePath(fromFile.path, folder), true);
  assert.deepEqual(fromFile.files.map((entry) => entry.name), ["one.md", "two.txt"]);
  assert.deepEqual(fromFile.dirs.map((entry) => entry.name), ["sub"]);
});

test("openFilePage reuses the page that already has the file open", () => {
  const store = loaded();
  const file = write(path.join(work, "report.md"), "# report\n");

  const first = store.openFilePage({ path: file });
  assert.equal(first.created, true);
  assert.equal(first.tab.title, "report.md");
  assert.equal(first.tab.file?.path, path.resolve(file));
  assert.equal(first.tab.file?.copy, undefined);
  assert.equal(store.findFilePage(file)?.id, first.tab.id);

  const again = store.openFilePage({ path: file });
  assert.equal(again.created, false);
  assert.equal(again.tab.id, first.tab.id);
  store.closeDb();
});

test("openFilePage from bytes keeps a copy under SCRIBE_HOME", () => {
  const store = loaded();
  const bytes = Buffer.from("dropped content\n", "utf8");

  const { tab, created } = store.openFilePage({ name: "dropped.txt", bytes });
  assert.equal(created, true);
  assert.equal(tab.title, "dropped.txt");
  assert.equal(tab.file?.copy, true);
  assert.ok(tab.file?.path.startsWith(path.join(dir, "files")), `copy at ${tab.file?.path}`);
  assert.deepEqual(fs.readFileSync(tab.file!.path), bytes);
  store.closeDb();
});

test("setFilePath renames the page and drops the copy", () => {
  const store = loaded();
  const { tab } = store.openFilePage({ name: "draft.txt", bytes: Buffer.from("draft\n") });
  const copyPath = tab.file!.path;
  const saved = write(path.join(work, "final.md"), "final\n");

  const renamed = store.setFilePath(tab.id, saved);
  assert.equal(renamed.title, "final.md");
  assert.equal(renamed.file?.path, path.resolve(saved));
  assert.equal(renamed.file?.copy, undefined);
  assert.equal(fs.existsSync(copyPath), false);
  assert.equal(store.findFilePage(saved)?.id, tab.id);
  store.closeDb();
});

test("openDiskFolder mirrors subfolders as Library folders and skips dependency and hidden entries", () => {
  const store = loaded();
  const root = path.join(work, "site");
  write(path.join(root, "index.md"), "# index\n");
  write(path.join(root, "docs", "guide.md"), "# guide\n");
  write(path.join(root, "docs", "api", "ref.json"), "{}\n");
  write(path.join(root, "node_modules", "pkg", "index.js"), "x\n");
  write(path.join(root, ".git", "config"), "x\n");
  write(path.join(root, "docs", ".draft.md"), "x\n");

  const result = store.openDiskFolder(root, null);
  assert.equal(result.pages, 3);
  assert.equal(result.reused, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.folder.name, "site");

  const folders = store.listFolders();
  const docs = folders.find((folder) => folder.name === "docs");
  const api = folders.find((folder) => folder.name === "api");
  assert.ok(docs, "docs folder");
  assert.ok(api, "api folder");
  assert.equal(docs.parentId, result.folder.id);
  assert.equal(api.parentId, docs.id);
  assert.equal(folders.some((folder) => folder.name === "node_modules"), false);

  const titles = store.list().map((tab) => tab.title);
  assert.equal(titles.includes("index.md"), false, "disk pages are not opened as tabs");
  const guide = store.findFilePage(path.join(root, "docs", "guide.md"));
  assert.equal(guide?.folderId, docs.id);
  assert.equal(store.findFilePage(path.join(root, "docs", "api", "ref.json"))?.folderId, api.id);
  assert.equal(store.findFilePage(path.join(root, "index.md"))?.folderId, result.folder.id);
  assert.equal(store.findFilePage(path.join(root, "node_modules", "pkg", "index.js")), undefined);
  assert.equal(store.findFilePage(path.join(root, "docs", ".draft.md")), undefined);

  const again = store.openDiskFolder(root, null);
  assert.equal(again.pages, 0);
  assert.equal(again.reused, 3);
  assert.equal(store.findFilePage(path.join(root, "index.md"))?.folderId, again.folder.id, "reused pages move into the new folder");
  store.closeDb();
});

test("file pages and their file binding survive a reload", () => {
  const store = loaded();
  const file = write(path.join(work, "kept.md"), "# kept\n");
  const { tab } = store.openFilePage({ path: file });
  const copy = store.openFilePage({ name: "copied.txt", bytes: Buffer.from("copy\n") }).tab;
  store.persist();
  store.closeDb();

  const again = loaded();
  const reopened = again.get(tab.id);
  assert.equal(reopened?.file?.path, path.resolve(file));
  assert.equal(reopened?.file?.copy, undefined);
  assert.equal(reopened?.title, "kept.md");
  assert.equal(again.get(copy.id)?.file?.copy, true);
  again.closeDb();
});

test("upsert refuses to overwrite a file page", () => {
  const store = loaded();
  const file = write(path.join(work, "locked.md"), "# locked\n");
  const { tab } = store.openFilePage({ path: file });

  assert.throws(
    () => store.upsert({ key: tab.key, title: "Overwritten", html: "<p>nope</p>" }),
    /file page/
  );
  assert.equal(store.get(tab.id)?.title, "locked.md");
  store.closeDb();
});

test("a temporary file page stays out of the Library and goes when its tab closes (#655)", () => {
  const store = loaded();
  const file = write(path.join(work, "shot.png"), Buffer.from([1, 2, 3]));
  const { tab } = store.openFilePage({ path: file, temp: true, activate: false });
  assert.equal(tab.temp, true);
  assert.equal(store.listClosedTabs().length, 0);
  assert.equal(store.closedCount(), 0);
  assert.equal(store.searchLibrary("").total, 0);
  store.openPage(tab.id);
  assert.throws(() => store.update(tab.id, { pin: true }), /can't be pinned/);
  store.closeTab(tab.id);
  assert.equal(store.get(tab.id), undefined);
  assert.equal(store.listTrash().length, 0);
  assert.throws(() => store.restoreLast(), /nothing to restore/);
  store.closeDb();
});

test("Keep in Library and opening the file for real make a temporary page permanent (#655)", () => {
  const store = loaded();
  const a = store.openFilePage({ path: write(path.join(work, "a.txt"), "a"), temp: true }).tab;
  store.keepPage(a.id);
  assert.equal(a.temp, undefined);
  store.closeTab(a.id);
  assert.ok(store.get(a.id));
  const b = store.openFilePage({ path: write(path.join(work, "b.txt"), "b"), temp: true, activate: false }).tab;
  const again = store.openFilePage({ path: b.file!.path });
  assert.equal(again.tab.id, b.id);
  assert.equal(b.temp, undefined);
  const c = store.openFilePage({ path: write(path.join(work, "c.txt"), "c"), temp: true }).tab;
  store.movePage(c.id, null, 0);
  assert.equal(c.temp, undefined);
  store.closeDb();
});

test("temporary pages survive a reload while open, and closed ones are dropped (#655)", () => {
  const store = loaded();
  const open = store.openFilePage({ path: write(path.join(work, "open.txt"), "o"), temp: true }).tab;
  const peeked = store.openFilePage({ path: write(path.join(work, "peek.txt"), "p"), temp: true, activate: false }).tab;
  store.persist();
  store.closeDb();
  const reloaded = loaded();
  assert.equal(reloaded.get(open.id)?.temp, true);
  assert.equal(reloaded.get(peeked.id), undefined);
  reloaded.closeDb();
});

test("openTempUrl makes one temporary embed page per site (#403)", () => {
  const store = loaded();
  const first = store.openTempUrl("https://example.com/a");
  assert.equal(first.created, true);
  assert.equal(first.tab.temp, true);
  assert.equal(first.tab.title, "example.com");
  assert.equal(store.openTempUrl("https://example.com/a").tab.id, first.tab.id);
  assert.throws(() => store.openTempUrl("javascript:alert(1)"));
  store.closeDb();
});

test("a markdown file's image links resolve beside the file, by absolute path, or by file: URL", () => {
  const md = path.join(dir, "docs", "notes.md");
  assert.equal(linkedImagePath(md, "img/shot.png"), path.join(dir, "docs", "img", "shot.png"));
  assert.equal(linkedImagePath(md, "../logo%20big.svg?raw=1#x"), path.join(dir, "logo big.svg"));
  const abs = path.join(dir, "elsewhere", "a.jpg");
  assert.equal(linkedImagePath(md, abs), abs);
  assert.equal(linkedImagePath(md, pathToFileURL(abs).href), abs);
  assert.equal(linkedImagePath(md, "https://example.com/a.png"), null);
  assert.equal(linkedImagePath(md, "//example.com/a.png"), null);
  assert.equal(linkedImagePath(md, "data:image/png;base64,AAAA"), null);
  assert.equal(linkedImagePath(md, "../secrets.txt"), null);
});

test("the file editor bundles into one script that defines ScribeEditor", () => {
  const code = editorBundle();
  assert.ok(code.length > 100_000);
  assert.match(code, /ScribeEditor/);
});
