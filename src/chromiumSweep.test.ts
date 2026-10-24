import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { classifyProcesses, profileDirOf } from "./chromiumSweep.js";

const exe = `"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"`;
const dirA = "C:\\Temp\\playwright_chromiumdev_profile-AAAA";
const dirB = "C:\\Temp\\playwright_chromiumdev_profile-BBBB";

test("profileDirOf reads quoted and bare Playwright profile folders only", () => {
  assert.equal(profileDirOf(`${exe} --type=renderer --user-data-dir="${dirA}" --foo`), dirA);
  assert.equal(profileDirOf(`${exe} --user-data-dir=${dirA} --remote-debugging-pipe`), dirA);
  assert.equal(profileDirOf(`${exe} --user-data-dir="C:\\Users\\me\\Brave\\User Data"`), undefined);
  assert.equal(profileDirOf(`powershell.exe -Command "... like '%playwright_chromiumdev_profile-%'"`), undefined);
});

test("classifyProcesses flags child groups whose main browser process is gone", () => {
  const { orphanPids, liveDirs } = classifyProcesses([
    { pid: 1, commandLine: `${exe} --disable-gpu --user-data-dir=${dirA} --remote-debugging-pipe` },
    { pid: 2, commandLine: `${exe} --type=renderer --user-data-dir="${dirA}"` },
    { pid: 3, commandLine: `${exe} --type=renderer --user-data-dir="${dirB}"` },
    { pid: 4, commandLine: `${exe} --type=crashpad-handler --user-data-dir=${dirB}` },
    { pid: 5, commandLine: `${exe} --user-data-dir="C:\\Users\\me\\Brave\\User Data"` },
  ]);
  assert.deepEqual(orphanPids.sort(), [3, 4]);
  assert.deepEqual([...liveDirs], [path.resolve(dirA).toLowerCase()]);
});
