import test from "node:test";
import assert from "node:assert/strict";
import { claudeToolsOff, cleanCustomModes, codexReadOnly, customInstructions, customKey, modeKeepsServer, piToolsOff, providerNotes, scribeToolsOff, threadCustom } from "./customModes.js";
import { DEFAULT_PREFS, prefsPatchFromChoices } from "./prefs.js";
import { serversForThread } from "./mcpConfig.js";
import { sandboxFor } from "./providers/codex.js";
import { toolLists, wantsHostShell } from "./providers/cursor.js";
import { builtinTools } from "./providers/pi.js";
import { threadInstructions } from "./prompt.js";
import type { Thread } from "./types.js";

const review = { id: "cm_review1", name: "Review", base: "full", off: ["edit", "subagents", "browser"], mcp: ["keeper"], instructions: "Report findings; never fix them.", approval: "auto" };

test("saved custom modes are cleaned: bad ids, bases, groups and duplicates go", () => {
  const modes = cleanCustomModes([
    review,
    { ...review, name: "Again" },
    { id: "code", name: "Shadow" },
    { id: "cm_blank1", name: "  " },
    { id: "cm_loose1", name: "Loose", base: "root", off: ["edit", "sudo"], mcp: "none", approval: "yolo", web: false },
    "nope",
  ]);
  assert.deepEqual(modes.map((m) => m.id), ["cm_review1", "cm_loose1"]);
  assert.deepEqual(modes[0], review);
  // An unknown base allows every rung, as a Code base did.
  assert.deepEqual(modes[1], { id: "cm_loose1", name: "Loose", base: "full", off: ["edit"], mcp: "none", instructions: "", web: "off" });
  assert.deepEqual(cleanCustomModes(null), []);
});

test("a thread carries a copy of its mode, with its highest rung and without the defaults", () => {
  const [mode] = cleanCustomModes([review]);
  const custom = threadCustom(mode);
  assert.deepEqual(custom, { id: "cm_review1", name: "Review", max: "full", off: ["edit", "subagents", "browser"], mcp: ["keeper"], instructions: "Report findings; never fix them." });
});

test("each provider takes the mode's tool groups away", () => {
  const thread = { custom: threadCustom(cleanCustomModes([{ ...review, off: ["edit", "shell", "web", "subagents", "helpers", "browser", "threads"] }])[0]) };
  assert.deepEqual(claudeToolsOff(thread), ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "BashOutput", "KillShell", "Monitor", "WebSearch", "WebFetch", "Agent", "Task"]);
  assert.deepEqual(piToolsOff(thread), ["edit", "write", "bash"]);
  assert.deepEqual(builtinTools("code", piToolsOff(thread)), ["read", "grep", "find", "ls"]);
  assert.deepEqual(scribeToolsOff(thread), { SCRIBE_TOOLS_OFF: "helpers,browser,threads" });
  assert.equal(customKey(thread), "edit,shell,web,subagents,helpers,browser,threads");
  const plain = {};
  assert.deepEqual(claudeToolsOff(plain), []);
  assert.deepEqual(scribeToolsOff(plain), {});
  assert.equal(customKey(plain), "");
});

test("Cursor: the groups come off the allowlist or join the denylist, and the host shell goes with the shell", () => {
  const custom = threadCustom(cleanCustomModes([{ ...review, off: ["edit", "shell"] }])[0]);
  const code = toolLists({ mode: "code", web: "on", custom });
  assert.ok(["edit", "delete", "shell"].every((name) => code.disallowedTools?.includes(name)));
  const ask = toolLists({ mode: "board", web: "on", cwd: "/work", custom: threadCustom(cleanCustomModes([{ ...review, off: ["web"] }])[0]) });
  assert.ok(ask.tools?.includes("read"));
  assert.ok(!ask.tools?.includes("webSearch"));
  assert.equal(wantsHostShell({ mode: "code", approval: "edits", custom }, true), false);
  assert.equal(wantsHostShell({ mode: "code", approval: "edits" }, true), true);
});

test("Codex: no edits or no shell falls back to the read-only sandbox", () => {
  const only = (off: string[]) => ({ custom: threadCustom(cleanCustomModes([{ ...review, off }])[0]) });
  assert.equal(codexReadOnly(only(["edit"])), true);
  assert.equal(codexReadOnly(only(["shell"])), true);
  assert.equal(codexReadOnly(only(["browser"])), false);
  assert.equal(sandboxFor({ mode: "code", approval: "full", ...only(["edit"]) }), "read-only");
  assert.equal(sandboxFor({ mode: "code", approval: "full", ...only(["browser"]) }), "danger-full-access");
  assert.match(providerNotes({ off: ["edit"] }, "codex")[0], /read-only sandbox/);
  assert.deepEqual(providerNotes({ off: ["edit"] }, "claude"), ["Shell commands can still change files."]);
  assert.deepEqual(providerNotes({ off: ["edit", "shell"] }, "claude"), []);
  assert.match(providerNotes({ off: ["subagents"] }, "pi")[0], /no subagents/);
});

test("a mode keeps all, none, or the named MCP servers", () => {
  const file = { mcpServers: { keeper: { command: "keeper" }, linear: { command: "linear" } }, workspaces: {} };
  const names = (mcp: unknown) => serversForThread({ mode: "code", cwd: null, worktree: null, custom: threadCustom(cleanCustomModes([{ ...review, mcp }])[0]) }, file as never, null).map((s) => s.name).sort();
  assert.deepEqual(names("all"), ["keeper", "linear"]);
  assert.deepEqual(names(["linear", "gone"]), ["linear"]);
  assert.deepEqual(names("none"), []);
  assert.equal(modeKeepsServer({}, "anything"), true);
});

test("the mode's limits and instructions reach the thread's instructions", () => {
  const custom = threadCustom(cleanCustomModes([review])[0]);
  assert.deepEqual(customInstructions({}), []);
  const lines = customInstructions({ custom });
  assert.match(lines[1], /Custom mode: Review\. Turned off in this mode: file editing, subagents, the browser tools\./);
  assert.equal(lines[2], "Report findings; never fix them.");
  const thread = { id: "th_1", provider: "claude", mode: "code", web: "on", approval: "edits", scope: { kind: "global", ref: null }, cwd: null, custom } as unknown as Thread;
  const text = threadInstructions(thread, { pages: [] } as never);
  assert.match(text, /Access: Edits\./);
  assert.match(text, /Custom mode: Review\./);
});

test("the last picked custom mode is remembered, and a built-in pick forgets it", () => {
  const custom = threadCustom(cleanCustomModes([review])[0]);
  const thread = { provider: "claude" as const, model: "default", effort: null, modelParams: {}, mode: "code" as const, approval: "edits" as const, web: "on" as const, scope: { kind: "global" as const, ref: null }, cwd: null };
  assert.equal(prefsPatchFromChoices(DEFAULT_PREFS, { ...thread, custom }, { customMode: "cm_review1" }).customMode, "cm_review1");
  assert.equal(prefsPatchFromChoices(DEFAULT_PREFS, thread, { mode: "code", customMode: null }).customMode, null);
  assert.equal("customMode" in prefsPatchFromChoices(DEFAULT_PREFS, thread, { approval: "edits" }), false);
});
