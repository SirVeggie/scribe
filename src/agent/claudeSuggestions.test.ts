import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestionsDescription, suggestionsLabel } from "./providers/claude.js";

test("Claude's suggested rules are spelled out with where they are saved", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }, { toolName: "Bash", ruleContent: "node:*" }], behavior: "allow", destination: "localSettings" },
    { type: "addDirectories", directories: ["C:\\work\\other"], destination: "session" },
  ];
  assert.equal(suggestionsLabel(suggestions), "Always allow");
  assert.equal(
    suggestionsDescription(suggestions),
    "Bash(git status:*), Bash(node:*) in this project's local settings\nAllow access to C:\\work\\other for this session"
  );
});

test("Rules without content, deny rules and unknown shapes", () => {
  assert.equal(suggestionsDescription([{ type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "deny", destination: "userSettings" }]), "Deny WebFetch in your user settings (every project)");
  assert.equal(suggestionsDescription([{ type: "setMode", mode: "acceptEdits", destination: "session" }]), "Switch to acceptEdits mode for this session");
  assert.equal(suggestionsDescription([null, { type: "addRules", rules: [] }]), "");
});
