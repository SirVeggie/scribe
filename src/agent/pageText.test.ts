import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// scribe.agent.onText (#998): a page's thread streams its reply text, whole, with deltas and a done per turn.

const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

function textContext() {
  const posts: any[] = [];
  const timers: Array<() => void> = [];
  const detail = { items: [] as any[], turns: new Map<string, any>() };
  const context = vm.createContext({
    S: { threads: new Map([["t1", { id: "t1", status: "running", scope: { kind: "page", ref: "tab1" } }]]), details: new Map([["t1", detail]]) },
    app: () => ({ postToPage: (ref: string, msg: any) => posts.push({ ref, ...msg }) }),
    setTimeout: (run: () => void) => (timers.push(run), timers.length),
    clearTimeout: () => {},
  });
  vm.runInContext(["const pageTextWatch = new Map();", "const PAGE_TEXT_MS = 80;", fn(chat, "pageReplyText"), fn(chat, "pageTextChanged")].join("\n"), context);
  const flush = () => timers.splice(0).forEach((run) => run());
  const watch = (sent = "", turnId: string | null = null, done = true) => vm.runInContext(`pageTextWatch.set("t1", { timer: null, turnId: ${JSON.stringify(turnId)}, sent: ${JSON.stringify(sent)}, done: ${done} })`, context);
  const changed = () => (vm.runInContext(`pageTextChanged("t1")`, context), flush());
  return { posts, detail, watch, changed };
}

test("a turn's reply streams whole with deltas, past 220 characters and new lines, and ends with done", () => {
  const { posts, detail, watch, changed } = textContext();
  detail.turns.set("u0", { id: "u0", seq: 1, status: "done" });
  detail.items.push({ id: "a", turnId: "u0", kind: "text", text: "Old reply." });
  watch("Old reply.", "u0", true);
  changed();
  assert.equal(posts.length, 0, "the settled turn the page subscribed during is not replayed");

  detail.turns.set("u1", { id: "u1", seq: 2, status: "running" });
  const reply = { id: "b", turnId: "u1", kind: "text", text: "First sentence." };
  detail.items.push(reply, { id: "r", turnId: "u1", kind: "reasoning", text: "thinking" }, { id: "s", turnId: "u1", kind: "text", parentToolId: "x", text: "helper" });
  changed();
  const long = "x".repeat(300);
  reply.text += `\n${long}`;
  changed();
  changed();
  detail.items.push({ id: "c", turnId: "u1", kind: "text", text: "After a tool." });
  detail.turns.get("u1").status = "done";
  changed();

  assert.deepEqual(posts.map((p) => [p.delta, p.done]), [
    ["First sentence.", false],
    [`\n${long}`, false],
    ["\n\nAfter a tool.", true],
  ]);
  assert.equal(posts.at(-1).text, `First sentence.\n${long}\n\nAfter a tool.`);
  assert.ok(posts.every((p) => p.ref === "tab1" && p.type === "scribe-agent-text" && p.turnId === "u1"));
});

test("a turn already running when the page subscribes starts from nothing; changed text resets", () => {
  const { posts, detail, watch, changed } = textContext();
  detail.turns.set("u1", { id: "u1", seq: 1, status: "running" });
  const reply = { id: "b", turnId: "u1", kind: "text", text: "Hello there" };
  detail.items.push(reply);
  watch("", "u1", false);
  changed();
  reply.text = "Hi there";
  changed();
  assert.deepEqual(posts.map((p) => [p.delta, Boolean(p.reset)]), [["Hello there", false], ["Hi there", true]]);
});
