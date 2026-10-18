import assert from "node:assert/strict";
import test from "node:test";
import { CursorProvider, isSdkAgentId, mapModels, modelSelection, toolLists, wantsHostShell } from "./providers/cursor.js";
import type { Thread } from "./types.js";
import type { SessionContext } from "./providers/provider.js";

const models = mapModels([
  {
    id: "composer-2",
    displayName: "Composer 2",
    parameters: [
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
      { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high", displayName: "High" }] },
    ],
    variants: [{ displayName: "default", isDefault: true, params: [{ id: "reasoning_effort", value: "medium" }, { id: "fast", value: "false" }] }],
  },
  { id: "gpt-5", displayName: "GPT-5" },
]);

test("mapModels takes the effort parameter and defaults from the default variant", () => {
  const [composer, gpt] = models;
  assert.equal(composer.effortParam, "reasoning_effort");
  assert.equal(composer.defaultEffort, "medium");
  assert.deepEqual(composer.efforts.map((e) => e.id), ["low", "medium", "high"]);
  assert.deepEqual(composer.params, [{ id: "fast", label: "Fast", options: [{ id: "false", label: "false" }, { id: "true", label: "true" }], default: "false" }]);
  assert.deepEqual(gpt.efforts, []);
  assert.equal(gpt.effortParam, undefined);
});

test("modelSelection passes only parameters the model takes", () => {
  assert.deepEqual(modelSelection({ model: "composer-2", effort: "high", modelParams: { fast: "true", context: "1m" } }, models), {
    id: "composer-2",
    params: [
      { id: "fast", value: "true" },
      { id: "reasoning_effort", value: "high" },
    ],
  });
  assert.deepEqual(modelSelection({ model: "composer-2", effort: "extreme", modelParams: { fast: "maybe" } }, models), { id: "composer-2" });
  assert.deepEqual(modelSelection({ model: "unknown-model", effort: "high", modelParams: {} }, models), { id: "unknown-model" });
  assert.deepEqual(modelSelection({ model: "default", effort: null, modelParams: {} }, models), { id: "composer-2" });
});

test("toolLists: the reading rungs are allowlists, web off drops the web tools", () => {
  assert.deepEqual(toolLists({ mode: "code", web: "on" }), { disallowedTools: ["askQuestion"] });
  assert.deepEqual(toolLists({ mode: "code", web: "off" }), { disallowedTools: ["askQuestion", "webSearch", "webFetch", "fetch", "xSearch"] });
  const board = toolLists({ mode: "board", web: "off" }).tools!;
  assert.ok(board.includes("mcp"));
  for (const tool of ["shell", "edit", "write", "delete", "webSearch", "webFetch", "task"]) assert.ok(!board.includes(tool), tool);
  assert.ok(toolLists({ mode: "board", web: "on" }).tools!.includes("webSearch"));
  // Read-only and Board with a workspace read files there (#718, #719).
  const ask = toolLists({ mode: "board", web: "off", cwd: "/work" }).tools!;
  assert.ok(ask.includes("read") && ask.includes("grep") && ask.includes("mcp"));
  for (const tool of ["shell", "edit", "write", "delete", "webFetch"]) assert.ok(!ask.includes(tool), tool);
});

test("isSdkAgentId tells SDK agents from old ACP sessions", () => {
  assert.equal(isSdkAgentId("agent-7f0c2b9e-1111-2222-3333-444455556666"), true);
  assert.equal(isSdkAgentId("0f8e7d6c-1111-2222-3333-444455556666"), false);
  assert.equal(isSdkAgentId(null), false);
});

test("host shell: only Code threads that ask, and it drops the built-in shell but keeps mcp", () => {
  assert.equal(wantsHostShell({ mode: "code", approval: "edits" }, true), true);
  assert.equal(wantsHostShell({ mode: "code", approval: "edits" }, false), false);
  assert.equal(wantsHostShell({ mode: "code", approval: "auto" }, true), false);
  assert.equal(wantsHostShell({ mode: "code", approval: "full" }, true), false);
  assert.equal(wantsHostShell({ mode: "board", approval: "board" }, true), false);
  const lists = toolLists({ mode: "code", web: "on" }, true).disallowedTools!;
  assert.ok(lists.includes("shell"));
  assert.ok(!lists.includes("mcp"));
});

test("Cursor retains an open agent across equivalent approval levels, but closes it for review or shell changes", () => {
  for (const mode of ["code", "board"] as const) {
    for (const hostShell of [false, true]) {
      const thread = { id: "cursor-policy", nativeId: null, mode, web: "off", approval: "edits", cwd: "/work", scope: { kind: "page", ref: "board" } } as Thread;
      const session = new CursorProvider().createSession(thread, { scratchDir: "/scratch", cursorHostShell: () => hostShell } as SessionContext);
      // Install an already-open agent without credentials, subprocesses or a model run.
      const opened = session as unknown as { key(): string; agentKey: string | null; agent: { close(): void } | null };
      let closes = 0;
      try {
        opened.agentKey = opened.key();
        opened.agent = { close() { closes++; } };
        session.update({ ...thread, approval: "edits" });
        assert.equal(closes, 0);
        session.update({ ...thread, approval: "auto" });
        assert.equal(closes, mode === "code" && hostShell ? 1 : 0);
        if (opened.agent) {
          session.update({ ...thread, approval: "full" });
          assert.equal(closes, mode === "code" ? 1 : 0);
        }
        // Full -> Edits must also rebuild agents outside the reading rungs.
        session.update({ ...thread, approval: "full" });
        opened.agentKey = opened.key();
        opened.agent = { close() { closes++; } };
        const before = closes;
        session.update(thread);
        assert.equal(closes - before, mode === "code" ? 1 : 0);
        opened.agentKey = opened.key();
        opened.agent = { close() { closes++; } };
        const beforeCustom = closes;
        session.update({ ...thread, custom: { id: "cm_test", name: "Limited", off: ["edit"], mcp: "all", instructions: "" } });
        assert.equal(closes - beforeCustom, 1);
      } finally { session.dispose(); }
    }
  }
});
