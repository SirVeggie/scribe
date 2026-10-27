import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { findSvnRoot, parseSvnStatus, svnEnd, svnStart, svnWorkingChanges } from "./svn.js";

const hasSvn = (() => {
  try {
    execFileSync("svnadmin", ["--version", "--quiet"], { windowsHide: true, stdio: "ignore" });
    execFileSync("svn", ["--version", "--quiet"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A fresh repository with a.txt, b.txt and src/c.txt committed, checked out to `wc`. */
function checkout(): { dir: string; wc: string; svn: (...args: string[]) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-svn-"));
  const repo = path.join(dir, "repo");
  execFileSync("svnadmin", ["create", repo], { windowsHide: true });
  const wc = path.join(dir, "wc");
  const svn = (...args: string[]) => void execFileSync("svn", ["--non-interactive", ...args], { cwd: wc, windowsHide: true, stdio: "ignore" });
  execFileSync("svn", ["--non-interactive", "checkout", pathToFileURL(repo).href, wc], { windowsHide: true, stdio: "ignore" });
  fs.writeFileSync(path.join(wc, "a.txt"), "a1\na2\n");
  fs.writeFileSync(path.join(wc, "b.txt"), "b1\n");
  fs.mkdirSync(path.join(wc, "src"));
  fs.writeFileSync(path.join(wc, "src", "c.txt"), "c1\n");
  svn("add", "a.txt", "b.txt", "src");
  svn("commit", "-m", "start");
  return { dir, wc, svn };
}

test("parses svn status xml, escaped names included", () => {
  const xml = `<?xml version="1.0"?><status><target path="."><entry path="a &amp; b.txt"><wc-status props="none" item="modified" revision="1"></wc-status></entry>
<entry path="new\\x.txt">
<wc-status item="unversioned" props="none"></wc-status></entry></target></status>`;
  assert.deepEqual(parseSvnStatus(xml), [{ path: "a & b.txt", item: "modified" }, { path: "new/x.txt", item: "unversioned" }]);
});

test("svn working copy changes against BASE", { skip: !hasSvn && "svn is not installed" }, async () => {
  const { dir, wc, svn } = checkout();
  try {
    assert.equal(findSvnRoot(path.join(wc, "src")), wc);
    assert.equal(findSvnRoot(dir), null);
    fs.writeFileSync(path.join(wc, "a.txt"), "a1\nchanged\n");
    svn("rm", "b.txt");
    fs.mkdirSync(path.join(wc, "new", "deep"), { recursive: true });
    fs.writeFileSync(path.join(wc, "new", "deep", "n.txt"), "n1\nn2\n");
    fs.rmSync(path.join(wc, "src", "c.txt"));
    const changes = (await svnWorkingChanges(wc))!;
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    // The unversioned folder is counted once, not listed.
    assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "b.txt", "src/c.txt"]);
    assert.equal(changes.unversioned, 1);
    assert.deepEqual([byPath["a.txt"].status, byPath["a.txt"].added, byPath["a.txt"].removed], ["M", 1, 1]);
    assert.equal(byPath["b.txt"].status, "D");
    assert.equal(byPath["src/c.txt"].status, "D");
    assert.match(changes.patch, /\+changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn's svn changes leave out what was already changed before it", { skip: !hasSvn && "svn is not installed" }, async () => {
  const { dir, wc } = checkout();
  try {
    fs.writeFileSync(path.join(wc, "a.txt"), "user edit\n");
    fs.writeFileSync(path.join(wc, "untracked.txt"), "mine\n");
    const start = (await svnStart(wc))!;
    // A shell command during the turn: edits a clean file and adds one. A file that already
    // existed unversioned changes too, as a log a running server appends to: not the turn's.
    fs.writeFileSync(path.join(wc, "b.txt"), "b1\nshell\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(wc, "untracked.txt"), "mine\nagent\n");
    fs.writeFileSync(path.join(wc, "src", "made.txt"), "made\n");
    const turn = await svnEnd(wc, start, new Map());
    assert.deepEqual(Object.fromEntries([...turn].sort(([a], [b]) => a.localeCompare(b))), {
      "b.txt": { before: "b1\n", after: "b1\nshell\n" },
      "src/made.txt": { before: null, after: "made\n" },
    });
    // Written by an edit tool, it is the turn's after all.
    const tool = await svnEnd(wc, start, new Map([["untracked.txt", { before: "mine\n", after: "mine\nagent\n" }]]));
    assert.deepEqual(tool.get("untracked.txt"), { before: "mine\n", after: "mine\nagent\n" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
