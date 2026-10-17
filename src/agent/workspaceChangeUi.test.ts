import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
const start = source.indexOf("    async setWorkspace(dir) {");
const end = source.indexOf("    async pickOtherWorkspace()", start);

test("workspace changes require confirmation and successful worktree cleanup", async () => {
  for (const scenario of ["cancel", "running", "failed", "change", "ordinary"]) {
    const calls: string[] = [];
    const thread = { id: "thread", status: scenario === "running" ? "running" : "idle" };
    const context = {
      dirKey: (dir: string) => dir,
      openWorktree: () => scenario === "ordinary" ? null : { branch: "agent/work" },
      notice: () => {},
      app: () => ({ confirm: async (warning: string) => {
        calls.push("confirm");
        assert.match(warning, /discards uncommitted changes/);
        return scenario !== "cancel";
      } }),
      api: async (_method: string, _url: string, body: { action: string }) => {
        calls.push(body.action);
        if (scenario === "failed") throw new Error("Cleanup failed");
        return { message: "Discarded" };
      },
    };
    const view = vm.runInNewContext(`({${source.slice(start, end)}})`, context);
    view.settings = () => ({ cwd: "old", scope: { kind: "workspace", ref: "old" } });
    view.thread = () => thread;
    view.updateSettings = async (patch: { cwd: string; scope: { ref: string } }) => {
      calls.push("update");
      assert.equal(patch.cwd, "new");
      assert.equal(patch.scope.ref, "new");
    };
    await view.setWorkspace("new");
    assert.deepEqual(calls, scenario === "cancel" ? ["confirm"]
      : scenario === "running" ? []
      : scenario === "failed" ? ["confirm", "discard"]
      : scenario === "ordinary" ? ["update"] : ["confirm", "discard", "update"]);
  }
});

test("worktree menu offers discard only while idle", () => {
  const menuStart = source.indexOf("    worktreeMenu(anchor) {");
  const menuEnd = source.indexOf("    /** What the user granted", menuStart);
  for (const status of ["idle", "running"]) {
    let rows: any[] = [];
    const view = vm.runInNewContext(`({${source.slice(menuStart, menuEnd)}})`, {
      openWorktree: () => ({ branch: "agent/work" }),
      openMenu: (_anchor: unknown, items: any[]) => { rows = items; },
    });
    view.thread = () => ({ status });
    const actions: string[] = [];
    view.finishWorktree = (how: string) => actions.push(how);
    view.worktreeMenu(null);
    const discard = rows.find(row => row.label === "Discard worktree…");
    assert.ok(discard);
    assert.equal(discard.danger, true);
    assert.equal(discard.disabled, status !== "idle");
    discard.run();
    assert.deepEqual(actions, ["discard"]);
  }
});

test("discard confirms loss of all work before posting and cancellation keeps it", async () => {
  const finishStart = source.indexOf("    async finishWorktree(how) {");
  const finishEnd = source.indexOf("    threadMenu(anchor)", finishStart);
  const fnStart = source.indexOf("  async function finishThreadWorktree(");
  const fnEnd = source.indexOf("  /* ---------- diff viewer", fnStart);
  for (const accept of [false, true]) {
    const calls: string[] = [];
    const view = vm.runInNewContext(`${source.slice(fnStart, fnEnd)}({${source.slice(finishStart, finishEnd)}})`, {
      openWorktree: () => ({ branch: "agent/work" }),
      notice: () => {},
      app: () => ({ confirm: async (warning: string, label: string) => {
        calls.push("confirm");
        assert.match(warning, /committed and uncommitted work on agent\/work/);
        assert.match(warning, /delete the branch/);
        assert.match(warning, /cannot be undone/);
        assert.match(warning, /main checkout is unchanged/);
        assert.match(warning, /threads sharing the worktree/);
        assert.equal(label, "Discard worktree");
        return accept;
      } }),
      api: async (method: string, url: string, body?: { action: string }) => {
        assert.equal(url, "/threads/thread/worktree");
        calls.push(method);
        if (method === "GET") return { status: { ahead: 2, dirty: ["untracked.txt"], mainBranch: "other" } };
        assert.equal(body?.action, "discard");
        return { message: "Discarded" };
      },
    });
    view.thread = () => ({ id: "thread", status: "idle" });
    await view.finishWorktree("discard");
    assert.deepEqual(calls, accept ? ["GET", "confirm", "POST"] : ["GET", "confirm"]);
  }
});
