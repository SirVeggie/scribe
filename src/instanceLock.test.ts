import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock, lockFile } from "./instanceLock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scribe-lock-"));

/** A live process that is not this one, to stand in for another daemon. */
function otherProcess(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { pid: child.pid!, stop: () => child.kill() };
}

test("a free data folder is locked, and released again", async () => {
  const dir = tmp();
  const lock = await acquireInstanceLock(dir, { port: 1234 });
  assert.equal(lock.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, process.pid);
  if (lock.ok) lock.release();
  assert.equal(fs.existsSync(lockFile(dir)), false);
});

test("a second daemon backs off while a live daemon answers on its port", async () => {
  const dir = tmp();
  const other = otherProcess();
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: other.pid, port: 4747, at: Date.now() }));
    const lock = await acquireInstanceLock(dir, { port: 4747, answers: async () => true, waitMs: 5000 });
    assert.equal(lock.ok, false);
    if (!lock.ok) assert.equal(lock.owner.pid, other.pid);
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, other.pid);
  } finally {
    other.stop();
  }
});

test("a live owner that is still starting keeps the lock past the wait", async () => {
  const dir = tmp();
  const other = otherProcess();
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: other.pid, port: 4747, at: Date.now() }));
    const lock = await acquireInstanceLock(dir, { port: 4747, answers: async () => false, waitMs: 300 });
    assert.equal(lock.ok, false);
  } finally {
    other.stop();
  }
});

test("a daemon that is stopping lets the next one in once it exits", async () => {
  const dir = tmp();
  const other = otherProcess();
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: other.pid, port: 4747, at: Date.now() }));
  setTimeout(() => {
    fs.rmSync(lockFile(dir), { force: true });
    other.stop();
  }, 400);
  const lock = await acquireInstanceLock(dir, { port: 4747, answers: async () => false, waitMs: 5000 });
  assert.equal(lock.ok, true);
  if (lock.ok) lock.release();
});

test("a crashed owner's lock is taken over", async () => {
  const dir = tmp();
  const other = otherProcess();
  other.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: other.pid, port: 4747, at: Date.now() }));
  const lock = await acquireInstanceLock(dir, { port: 4747, answers: async () => true });
  assert.equal(lock.ok, true);
  if (lock.ok) lock.release();
});

test("an old lock whose process id was reused and never answered is taken over", async () => {
  const dir = tmp();
  const other = otherProcess();
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: other.pid, port: 4747, at: Date.now() - 10 * 60_000 }));
    const lock = await acquireInstanceLock(dir, { port: 4747, answers: async () => false, waitMs: 200 });
    assert.equal(lock.ok, true);
    if (lock.ok) lock.release();
  } finally {
    other.stop();
  }
});
