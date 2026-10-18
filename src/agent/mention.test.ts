import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionAt } from "./mention.js";
import fs from "node:fs";
import vm from "node:vm";

test("the mention picker keeps Here results for @ and isolates # thread results", () => {
  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const picker = source.slice(source.indexOf("    hereMentions("), source.indexOf("    pickMention("));
  const key = source.slice(source.indexOf("  function chipKey("), source.indexOf("  function chipIcon("));
  const score = source.slice(source.indexOf("  function mentionScore("), source.indexOf("  function mentionToken("));
  const element = (_tag: string, className: string, text?: string) => ({ className, text, dataset: {}, append() {}, addEventListener() {}, setAttribute() {} });
  const view = vm.runInNewContext(`${key}\n${score}\nnew (class {${picker}})()`, {
    activeTab: () => ({ id: "current", key: "scribe:current", title: "Current", folderId: "folder" }),
    folderPath: () => "Apps",
    el: element, button: (_text: string, className: string) => element("button", className),
    icon: () => ({}), chipIcon: () => "page",
  });
  const children: any[] = [];
  view.slash = {
    classList: { toggle() {} }, setAttribute() {},
    replaceChildren() { children.length = 0; },
    append(child: any) { children.push(child); },
    querySelector: () => children.find((child) => child.className.startsWith("ag-slash-item")),
  };
  view.knownMentionKeys = () => new Set();
  const headings = () => children.filter((child) => child.className === "ag-slash-head").map((child) => child.text);
  view.renderMentionPicker({
    pages: [{ kind: "page", id: "current" }, { kind: "page", id: "other", title: "Other" }],
    folders: [{ kind: "folder", id: "folder", path: "Apps" }],
    mention: { start: 0, query: "" }, loading: false,
  });
  assert.deepEqual(headings(), ["Here", "Library"]);
  assert.equal(children.filter((child) => child.className.startsWith("ag-slash-item")).length, 3);
  view.renderMentionPicker({ threads: [{ kind: "thread", id: "target", title: "Target" }], mention: { start: 0, query: "", thread: true }, loading: false });
  assert.deepEqual(headings(), ["Threads"]);
  assert.equal(view.slash.hidden, false);
  // No matches: the picker hides instead of saying so, and remembers the query as dead.
  view.renderMentionPicker({ threads: [], mention: { start: 0, query: "zz", thread: true }, loading: false });
  assert.deepEqual(children, []);
  assert.equal(view.slash.hidden, true);
  assert.deepEqual({ ...view.mentionDead }, { start: 0, query: "zz", thread: true });
});

test("the mention picker puts pages and folders in one list, best match first", () => {
  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const picker = source.slice(source.indexOf("    renderMentionPicker("), source.indexOf("    pickMention("));
  const key = source.slice(source.indexOf("  function chipKey("), source.indexOf("  function chipIcon("));
  const score = source.slice(source.indexOf("  function mentionScore("), source.indexOf("  function mentionToken("));
  const element = (_tag: string, className: string, text?: string) => ({ className, text, dataset: {}, append(...kids: any[]) { (this as any).kids = kids; }, addEventListener() {}, setAttribute() {} });
  const view = vm.runInNewContext(`${key}\n${score}\nnew (class {${picker}})()`, {
    el: element, button: (_text: string, className: string) => element("button", className), icon: () => ({}), chipIcon: () => "page",
  });
  const children: any[] = [];
  view.slash = { classList: { toggle() {} }, setAttribute() {}, replaceChildren() { children.length = 0; }, append(child: any) { children.push(child); }, querySelector: () => children.find((c) => c.className.startsWith("ag-slash-item")) };
  view.knownMentionKeys = () => new Set();
  view.hereMentions = () => [];
  view.renderMentionPicker({
    pages: [{ kind: "page", id: "a", title: "Notes on the design" }, { kind: "page", id: "b", title: "Design notes" }],
    folders: [{ kind: "folder", id: "f", path: "Apps/Design" }],
    mention: { start: 0, query: "design" }, loading: false,
  });
  assert.deepEqual(children.filter((c) => c.className === "ag-slash-head").map((c) => c.text), ["Library"]);
  assert.deepEqual(children.filter((c) => c.className.startsWith("ag-slash-item")).map((c) => c.kids[1].text), ["Apps/Design", "Design notes", "Notes on the design"]);
});

test("mentionAt finds @ after start or whitespace", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("@todo", 5), { start: 0, end: 5, query: "todo" });
  assert.deepEqual(mentionAt("see @todo now", 9), { start: 4, end: 9, query: "todo" });
  assert.equal(mentionAt("user@host", 9), null);
  assert.equal(mentionAt("see todo", 8), null);
});

test("mentionAt uses the prefix before the caret and replaces the whole token", () => {
  assert.deepEqual(mentionAt("@foobar", 4), { start: 0, end: 7, query: "foo" });
  assert.deepEqual(mentionAt("a @x b", 4), { start: 2, end: 4, query: "x" });
});

test("mentionAt allows spaces in the query, but not right after the @", () => {
  assert.deepEqual(mentionAt("see @Scribe To", 14), { start: 4, end: 14, query: "Scribe To" });
  assert.equal(mentionAt("meet @ 5pm", 10), null);
  assert.equal(mentionAt("@a\nb", 4), null);
  assert.equal(mentionAt(`@${"x".repeat(61)}`, 62), null);
  // floor: the text of a placed mention is not a new query.
  assert.equal(mentionAt("@Design 1 more", 14, "@", 9), null);
  assert.deepEqual(mentionAt("@Design 1 @pa", 13, "@", 9), { start: 10, end: 13, query: "pa" });
});

test("# finds thread references without treating embedded hashes or @ as thread tags", () => {
  assert.deepEqual(mentionAt("#", 1, "#"), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("see #foobar next", 8, "#"), { start: 4, end: 11, query: "foo" });
  assert.equal(mentionAt("url#fragment", 12, "#"), null);
  assert.equal(mentionAt("@todo", 5, "#"), null);
});

test("the composer searches # threads and replaces the selected token with a context chip", async () => {
  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const load = source.slice(source.indexOf("    async loadMentions("), source.indexOf("    localFolderMentions("));
  const pick = source.slice(source.indexOf("    pickMention("), source.indexOf("    async stop()"));
  const helpers = source.slice(source.indexOf("  const MENTION_QUERY_MAX"), source.indexOf("  function chipTitle("));
  const caret = source.slice(source.indexOf("    mentionAtCaret("), source.indexOf("    async showSlash("));
  const inline = source.slice(source.indexOf("    inlineMentions() {"), source.indexOf("    /** After an edit"));
  const methods = vm.runInNewContext(`${helpers}\n({${load}, ${pick}, ${caret}, ${inline}})`, {
    MENTION_LIMIT: 32, R: { basename: (p: string) => p },
    api: async (method: string, route: string) => {
      assert.equal(method, "GET");
      assert.equal(route, "/threads");
      return { threads: [
        { id: "self", title: "Thread work" },
        { id: "taken", title: "Thread taken" },
        { id: "target", title: "Thread to read" },
        { id: "other", title: "Something else" },
      ] };
    },
  });
  let rendered: any;
  const input = { value: "see #Thread next", selectionStart: 11, selectionEnd: 11, setSelectionRange(start: number, end: number) { assert.equal(start, end); this.selectionStart = start; this.selectionEnd = end; } };
  const view = {
    ...methods, threadId: "self", mentionGen: 1, mentionLoading: true, mentions: [], input,
    slash: { hidden: true },
    knownMentionKeys: () => new Set(["thread:taken"]),
    renderMentionPicker: (result: any) => { rendered = result; },
    hidePicker() {}, renderContext() {}, autosize() {}, focus() {},
  };
  const token = { ...mentionAt(input.value, input.selectionStart, "#"), thread: true };
  await view.loadMentions(token, 1);
  assert.deepEqual(Array.from(rendered.threads, (t: any) => t.id), ["target"]);
  assert.equal(view.mentionLoading, false);
  view.pickMention(rendered.threads[0], token);
  // The pick stays in the text as one inline mention, with a space after it.
  assert.equal(input.value, "see #Thread to read next");
  assert.equal(input.selectionStart, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(view.mentions)), [{ kind: "thread", id: "target", title: "Thread to read", inline: true, token: "#Thread to read", start: 4, end: 19 }]);
});

test("inline mentions move with edits around them and drop when an edit cuts into them", () => {
  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("  const MENTION_QUERY_MAX"), source.indexOf("  function chipTitle("));
  const inline = source.slice(source.indexOf("    inlineMentions() {"), source.indexOf("    /** Draw the pills"));
  const view = vm.runInNewContext(`${helpers}\nnew (class {${inline}})()`, { R: { basename: (p: string) => p } });
  const page = { kind: "page", id: "p", key: "scribe:p", title: "Design 1" };
  view.input = { value: "use @Design 1 now", selectionEnd: 0 };
  view.mentions = [{ ...page, inline: true, token: "@Design 1", start: 4, end: 13 }];
  view.renderContext = () => {};
  view.inputPrev = view.input.value;
  const edit = (value: string, caret: number) => {
    view.input.value = value;
    view.input.selectionEnd = caret;
    view.syncInline();
    return view.mentions.filter((c: any) => c.inline).map((c: any) => [c.start, c.end]);
  };
  assert.deepEqual(edit("so use @Design 1 now", 3), [[7, 16]]);
  // A letter typed right after the mention that repeats its last one stays outside it.
  assert.deepEqual(edit("so use @Design 11 now", 17), [[7, 16]]);
  assert.deepEqual(edit("so use @Design 1 now", 16), [[7, 16]]);
  // An edit inside the mention removes it, as Backspace over it would.
  assert.deepEqual(edit("so use @Desxign 1 now", 11), []);
  assert.equal(view.mentions.length, 0);
});
