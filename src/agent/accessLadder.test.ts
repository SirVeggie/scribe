import test from "node:test";
import assert from "node:assert/strict";
import { changeAccess, parseApproval, parseMode, settleAccess } from "./types.js";
import { cleanCustomModes, customKey, scribeToolsOff, threadCustom } from "./customModes.js";
import { cleanApprovals, cleanDisabledModes } from "./prefs.js";
import { workerAccess, workerSettings } from "../actions/kanbanWorkers.js";
import { checkPermission, normalizeFolders } from "../pagePermissions.js";

test("old values read as rungs: ask approval is Edits, ask mode is Board", () => {
  assert.equal(parseApproval("ask"), "edits");
  assert.equal(parseApproval("readonly"), "readonly");
  assert.equal(parseApproval("yolo"), null);
  assert.equal(parseMode("ask"), "board");
  assert.equal(parseMode("readonly"), null);
});

test("stored threads migrate: code + ask is Edits, ask and board are Board, plan reads as code", () => {
  assert.deepEqual(settleAccess("code", "ask"), { mode: "code", approval: "edits" });
  assert.deepEqual(settleAccess("code", "full"), { mode: "code", approval: "full" });
  assert.deepEqual(settleAccess("ask", "auto"), { mode: "board", approval: "board" });
  assert.deepEqual(settleAccess("board", "full"), { mode: "board", approval: "board" });
  assert.deepEqual(settleAccess("board", "readonly"), { mode: "board", approval: "readonly" });
  assert.deepEqual(settleAccess("plan", "ask"), { mode: "code", approval: "edits" });
  assert.deepEqual(settleAccess("plan", "auto"), { mode: "code", approval: "auto" });
  // The rung decides: a reading rung runs as a board thread.
  assert.deepEqual(settleAccess("code", "readonly"), { mode: "board", approval: "readonly" });
});

test("changing the rung moves the mode with it; old mode names still work", () => {
  const board = { mode: "board" as const, approval: "board" as const };
  assert.deepEqual(changeAccess(board, { approval: "edits" }, "auto"), { mode: "code", approval: "edits" });
  assert.deepEqual(changeAccess(board, { mode: "code" }, "full"), { mode: "code", approval: "full" });
  assert.deepEqual(changeAccess(board, { mode: "plan" }, "readonly"), { mode: "code", approval: "edits" });
  assert.deepEqual(changeAccess({ mode: "code", approval: "auto" }, { approval: "full" }, "edits"), { mode: "code", approval: "full" });
  assert.deepEqual(changeAccess({ mode: "code", approval: "auto" }, { approval: "board" }, "edits"), { mode: "board", approval: "board" });
  assert.deepEqual(changeAccess({ mode: "code", approval: "full" }, { mode: "ask" }, "edits"), { mode: "board", approval: "board" });
  assert.deepEqual(changeAccess({ mode: "code", approval: "full" }, { mode: "board", approval: "readonly" }, "edits"), { mode: "board", approval: "readonly" });
  // A page that still sends Pages mode with an approval gets Board.
  assert.deepEqual(changeAccess(board, { mode: "board", approval: "auto" }, "edits"), { mode: "board", approval: "board" });
  // A custom mode's highest rung caps it.
  assert.deepEqual(changeAccess(board, { approval: "full" }, "edits", "edits"), { mode: "code", approval: "edits" });
  assert.deepEqual(changeAccess({ mode: "code", approval: "full" }, {}, "edits", "board"), { mode: "board", approval: "board" });
});

test("custom modes: an old base becomes the highest rung, and their rung stays under it", () => {
  const modes = cleanCustomModes([
    { id: "cm_coder1", name: "Coder", base: "code", approval: "ask" },
    { id: "cm_planr1", name: "Planner", base: "plan" },
    { id: "cm_board1", name: "Pages", base: "board", approval: "full" },
    { id: "cm_reads1", name: "Reads", base: "readonly" },
  ]);
  assert.deepEqual(modes.map((m) => [m.base, m.approval, m.plan]), [["full", "edits", undefined], ["full", undefined, true], ["board", "board", undefined], ["readonly", undefined, undefined]]);
  assert.equal(threadCustom(modes[3]).max, "readonly");
});

test("the Read-only rung loses Scribe's page writes and restarts its session", () => {
  assert.deepEqual(scribeToolsOff({ approval: "readonly" }), { SCRIBE_TOOLS_OFF: "pagewrite" });
  assert.deepEqual(scribeToolsOff({ approval: "board" }), {});
  assert.notEqual(customKey({ approval: "readonly" }), customKey({ approval: "board" }));
});

test("prefs: Ask first is Edits, old mode defaults and cycle lists are dropped", () => {
  assert.deepEqual(cleanApprovals({ approval: "ask" as never, approvals: { claude: "ask" as never, cursor: "full", bogus: "edits" } as never }), {
    approval: "edits",
    approvals: { claude: "edits", cursor: "full" },
  });
  assert.deepEqual(cleanDisabledModes(["code", "ask", "board", "full"]), ["board", "full"]);
});

test("board workers: older mode settings launch on their rung", () => {
  assert.deepEqual(workerAccess({ mode: "code", approval: "ask" }), { mode: "code", approval: "edits" });
  assert.deepEqual(workerAccess({ mode: "board", approval: "auto" }), { mode: "board", approval: "board" });
  assert.deepEqual(workerAccess({}), { mode: "code", approval: "auto" });
  assert.deepEqual(workerAccess({ mode: "plan" }), { mode: "code", approval: "auto" });
  const card = { id: "c1", num: 3, title: "T" } as never;
  const launch = workerSettings({ name: "W", mode: "ask", approval: "full", cwd: "C:\\x" }, card);
  assert.equal(launch.mode, "board");
  assert.equal(launch.approval, "board");
  assert.equal(launch.cwd, undefined);
});

test("folder grants: an old Ask first grant covers Edits, not more", () => {
  const folder = process.platform === "win32" ? "C:\\work" : "/work";
  const grants = new Map([["agent.workspace", { value: "ask" as const, folders: normalizeFolders([{ path: folder, approval: "ask" }]), updatedAt: 1 }]]);
  assert.equal(checkPermission(grants, { perm: "agent.workspace", folder, approval: "edits" }), "allow");
  assert.equal(checkPermission(grants, { perm: "agent.workspace", folder, approval: "board" }), "allow");
  assert.equal(checkPermission(grants, { perm: "agent.workspace", folder, approval: "auto" }), "ask");
});
