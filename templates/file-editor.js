// The file page's editor (#658): CodeMirror 6, bundled by the daemon into /vendor/editor.js
// (src/editorBundle.ts) and exposed to templates/file-page.html as window.ScribeEditor.
import { EditorState, EditorSelection, Compartment, Text, Transaction } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, highlightActiveLine, runScopeHandlers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory, undo } from "@codemirror/commands";
import {
  search, highlightSelectionMatches, openSearchPanel, closeSearchPanel, findNext, findPrevious, replaceNext,
  replaceAll, selectNextOccurrence, selectSelectionMatches, gotoLine, SearchQuery, setSearchQuery, getSearchQuery,
} from "@codemirror/search";
import {
  indentUnit, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle, StreamLanguage,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { go } from "@codemirror/lang-go";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { r } from "@codemirror/legacy-modes/mode/r";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { kotlin, scala, dart, csharp, objectiveC } from "@codemirror/legacy-modes/mode/clike";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { fSharp, oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { stex } from "@codemirror/legacy-modes/mode/stex";

// Past this size the file opens without a grammar: parsing stays in the background, but folding and
// bracket matching over a huge tree cost more than they give.
const LANGUAGE_MAX = 4 * 1024 * 1024;

const legacy = (mode) => () => StreamLanguage.define(mode);
/** Scribe's language names (highlight.js names, from src/filePages.ts) to CodeMirror languages. */
const LANGUAGES = {
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  json: () => json(),
  css: () => css(), scss: () => css(), less: () => css(),
  html: () => html(),
  xml: () => xml(),
  markdown: () => markdown({ codeLanguages: codeLanguage }),
  python: () => python(),
  sql: () => sql(),
  yaml: () => yaml(),
  rust: () => rust(),
  c: () => cpp(), cpp: () => cpp(),
  java: () => java(),
  php: () => php(),
  go: () => go(),
  bash: legacy(shell), shell: legacy(shell),
  powershell: legacy(powerShell),
  ruby: legacy(ruby), lua: legacy(lua), perl: legacy(perl), r: legacy(r), swift: legacy(swift),
  kotlin: legacy(kotlin), scala: legacy(scala), dart: legacy(dart), csharp: legacy(csharp), objectivec: legacy(objectiveC),
  haskell: legacy(haskell), erlang: legacy(erlang), clojure: legacy(clojure), fsharp: legacy(fSharp), ocaml: legacy(oCaml),
  julia: legacy(julia), groovy: legacy(groovy), gradle: legacy(groovy),
  ini: legacy(properties), properties: legacy(properties), toml: legacy(toml),
  protobuf: legacy(protobuf), dockerfile: legacy(dockerFile), cmake: legacy(cmake), diff: legacy(diff), latex: legacy(stex),
};
/** Fenced code block names in markdown that differ from the names above. */
const ALIASES = {
  js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", py: "python",
  sh: "bash", zsh: "bash", console: "bash", ps1: "powershell", pwsh: "powershell", yml: "yaml", rs: "rust",
  "c++": "cpp", h: "c", hpp: "cpp", cs: "csharp", "c#": "csharp", rb: "ruby", kt: "kotlin", htm: "html",
  svg: "xml", md: "markdown", jsonc: "json", json5: "json", patch: "diff", tex: "latex", docker: "dockerfile",
  proto: "protobuf", fs: "fsharp", ml: "ocaml", hs: "haskell", jl: "julia", pl: "perl",
};

function codeLanguage(info) {
  const name = String(info || "").trim().toLowerCase();
  const make = LANGUAGES[ALIASES[name] || name];
  if (!make || name === "markdown" || name === "md") return null;
  const support = make();
  return support.language || support;
}

/** The language for a file: its kind, Scribe's language name, and its name (for .tsx and .toml). */
function languageFor(kind, lang, name) {
  const ext = /\.([^.]+)$/.exec(String(name || "").toLowerCase());
  const e = ext ? ext[1] : "";
  if (kind === "json") return json();
  if (kind === "markdown") return LANGUAGES.markdown();
  if (kind === "html" || e === "vue" || e === "svelte") return html();
  if (e === "tsx") return javascript({ typescript: true, jsx: true });
  if (e === "toml") return LANGUAGES.toml();
  if (kind !== "code") return [];
  const make = LANGUAGES[lang];
  return make ? make() : [];
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: "var(--hl-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.escape, t.unit], color: "var(--hl-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.labelName, t.tagName], color: "var(--hl-title)" },
  { tag: t.heading, color: "var(--hl-title)", fontWeight: "650" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName), t.standard(t.tagName)], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName), t.special(t.variableName)], color: "var(--hl-attr)" },
  { tag: [t.meta, t.angleBracket, t.processingInstruction, t.documentMeta, t.annotation], color: "var(--hl-meta)" },
  { tag: [t.link, t.url], color: "#82aaff" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.inserted, color: "#9ad48b" },
  { tag: [t.deleted, t.invalid], color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--code-bg)", color: "var(--text)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { padding: "10px 0 40vh", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 14px 0 6px" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "#55555d", borderRight: "1px solid var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", minWidth: "32px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "#55555d" },
  ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.025)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(130, 170, 255, 0.3)" },
  ".cm-selectionMatch": { backgroundColor: "rgba(255, 255, 255, 0.09)" },
  ".cm-searchMatch": { backgroundColor: "rgba(224, 180, 92, 0.22)", outline: "1px solid rgba(224, 180, 92, 0.45)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(224, 180, 92, 0.5)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(255, 255, 255, 0.14)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "rgba(224, 122, 122, 0.3)" },
  ".cm-foldPlaceholder": { backgroundColor: "rgba(255, 255, 255, 0.08)", border: "none", color: "var(--muted)", padding: "0 6px" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield": {
    font: "12px var(--mono)", color: "var(--text)", backgroundColor: "var(--code-bg)", border: "1px solid var(--border)",
    borderRadius: "6px", height: "26px", padding: "0 8px", outline: "none",
  },
  ".cm-textfield:focus": { borderColor: "rgba(255, 255, 255, 0.24)" },
  ".cm-textfield, .cm-button": { margin: "0" },
  // The page's own button look, over CodeMirror's small gradient buttons.
  ".cm-button": {
    backgroundImage: "none", background: "rgba(255, 255, 255, 0.06)", color: "var(--text)", font: "inherit", fontSize: "12px",
    height: "26px", padding: "0 10px", border: "1px solid var(--border)", borderRadius: "7px", cursor: "pointer",
  },
  ".cm-button:hover": { background: "rgba(255, 255, 255, 0.1)" },
  ".cm-button:active": { backgroundImage: "none" },
  ".cm-gotoLine": { display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", fontSize: "12px" },
  ".cm-gotoLine label": { display: "flex", alignItems: "center", gap: "8px" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "6px" },
  // The find panel (findPanel below).
  ".sx": { display: "grid", gridTemplateColumns: "minmax(140px, 360px) auto", gap: "6px 8px", padding: "6px 10px", alignItems: "center", fontSize: "12px" },
  ".sx-row": { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
  ".sx-field": { position: "relative", display: "flex", alignItems: "center" },
  ".sx-field .cm-textfield": { width: "100%", paddingRight: "84px" },
  ".sx-opts": { position: "absolute", right: "3px", display: "flex", gap: "2px" },
  ".sx-opt": { height: "20px", minWidth: "24px", padding: "0 4px", border: "0", borderRadius: "4px", background: "transparent", color: "var(--muted)", font: "11px var(--mono)" },
  ".sx-opt:hover": { background: "rgba(255, 255, 255, 0.08)", color: "var(--text)" },
  ".sx-opt.on": { background: "rgba(130, 170, 255, 0.22)", color: "var(--text)" },
  ".sx-count": { color: "var(--muted)", minWidth: "64px", whiteSpace: "nowrap" },
  ".sx-count.none": { color: "var(--danger)" },
  ".sx-icon": { width: "26px", padding: "0", fontSize: "14px" },
});

// ---------- find / replace panel ----------
// A panel of our own rather than CodeMirror's: its options are toggle buttons in the page's style
// instead of native checkboxes, and it counts the matches.
const COUNT_MAX = 9999;
const panels = new WeakMap();

function findPanel(view) {
  const el = (tag, cls, attrs) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const key in attrs || {}) node.setAttribute(key, attrs[key]);
    return node;
  };
  const dom = el("div", "sx");
  const findInput = el("input", "cm-textfield", { placeholder: "Find", "aria-label": "Find", "main-field": "true" });
  const replaceInput = el("input", "cm-textfield", { placeholder: "Replace", "aria-label": "Replace" });
  const opt = (label, name, tip) => {
    const b = el("button", "sx-opt", { type: "button", "aria-label": tip, "aria-pressed": "false", "data-tooltip": tip });
    b.textContent = label;
    b.dataset.opt = name;
    return b;
  };
  const caseBtn = opt("Aa", "caseSensitive", "Match case (Alt+C)");
  const wordBtn = opt("ab", "wholeWord", "Whole word (Alt+W)");
  const reBtn = opt(".*", "regexp", "Regular expression (Alt+R)");
  const opts = el("div", "sx-opts");
  opts.append(caseBtn, wordBtn, reBtn);
  const findField = el("div", "sx-field");
  findField.append(findInput, opts);
  const count = el("span", "sx-count");
  const button = (label, tip, run, cls) => {
    const b = el("button", "cm-button" + (cls ? " " + cls : ""), { type: "button" });
    b.textContent = label;
    if (tip) { b.setAttribute("aria-label", tip); b.dataset.tooltip = tip; }
    b.addEventListener("click", () => { run(view); });
    return b;
  };
  const row1 = el("div", "sx-row");
  row1.append(
    count,
    button("↑", "Previous match (Shift+Enter)", findPrevious, "sx-icon"),
    button("↓", "Next match (Enter)", findNext, "sx-icon"),
    button("All", "Select all matches (Alt+Enter)", selectMatches),
    button("×", "Close (Esc)", (v) => { closeSearchPanel(v); v.focus(); }, "sx-icon"),
  );
  const row2 = el("div", "sx-row");
  row2.append(button("Replace", "Replace (Enter)", replaceNext), button("Replace all", "Replace all (Ctrl+Alt+Enter)", replaceAll));
  dom.append(findField, row1, replaceInput, row2);

  let query = getSearchQuery(view.state);
  let countTimer = 0;
  function sync() {
    if (findInput.value !== query.search) findInput.value = query.search;
    if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
    for (const b of [caseBtn, wordBtn, reBtn]) {
      const on = Boolean(query[b.dataset.opt]);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  function commit(patch) {
    const next = new SearchQuery({
      search: findInput.value, replace: replaceInput.value, caseSensitive: query.caseSensitive,
      regexp: query.regexp, wholeWord: query.wholeWord, ...patch,
    });
    if (!next.eq(query)) {
      query = next;
      view.dispatch({ effects: setSearchQuery.of(next) });
    }
    sync();
  }
  function recount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const state = view.state;
      count.classList.remove("none");
      if (!query.search) { count.textContent = ""; return; }
      if (!query.valid) { count.textContent = "Bad pattern"; count.classList.add("none"); return; }
      const main = state.selection.main;
      let n = 0, at = 0;
      const cursor = query.getCursor(state);
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        n++;
        if (next.value.from === main.from && next.value.to === main.to) at = n;
        if (n > COUNT_MAX) break;
      }
      count.textContent = n === 0 ? "No results" : n > COUNT_MAX ? COUNT_MAX + "+" : (at ? at + " of " : "") + n;
      count.classList.toggle("none", n === 0);
    }, isLarge(view) ? 150 : 0);
  }
  function selectMatches(v) { if (selectSelectionMatchesFromQuery(v)) v.focus(); }

  findInput.addEventListener("input", () => commit());
  replaceInput.addEventListener("input", () => commit());
  opts.addEventListener("mousedown", (e) => e.preventDefault());
  opts.addEventListener("click", (e) => {
    const b = e.target.closest("[data-opt]");
    if (b) commit({ [b.dataset.opt]: !query[b.dataset.opt] });
  });
  dom.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.altKey && !e.ctrlKey && !e.metaKey && (k === "c" || k === "w" || k === "r")) {
      e.preventDefault();
      const name = k === "c" ? "caseSensitive" : k === "w" ? "wholeWord" : "regexp";
      commit({ [name]: !query[name] });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.altKey && !e.ctrlKey) selectMatches(view);
      else if (e.target === replaceInput) (e.ctrlKey && e.altKey ? replaceAll : replaceNext)(view);
      else (e.shiftKey ? findPrevious : findNext)(view);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
      return;
    }
    if (runScopeHandlers(view, e, "search-panel")) e.preventDefault();
  });
  sync();

  const panel = {
    dom,
    top: true,
    mount() { findInput.select(); recount(); },
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) { query = effect.value; sync(); }
        }
      }
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((fx) => fx.is(setSearchQuery)))) recount();
    },
    destroy() { clearTimeout(countTimer); panels.delete(view); },
    focusFind() { findInput.focus(); findInput.select(); },
    focusReplace() { replaceInput.focus(); replaceInput.select(); },
  };
  panels.set(view, panel);
  return panel;
}
function isLarge(view) { return view.state.doc.length > 1024 * 1024; }

/** Select every match of the panel's query (or of the selection, without one), like VS Code's Alt+Enter. */
function selectSelectionMatchesFromQuery(view) {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return selectSelectionMatches(view);
  const ranges = [];
  const cursor = query.getCursor(view.state);
  for (let next = cursor.next(); !next.done && ranges.length < 10000; next = cursor.next()) ranges.push(next.value);
  if (!ranges.length) return false;
  view.dispatch({ selection: EditorSelection.create(ranges.map((m) => EditorSelection.range(m.from, m.to))) });
  return true;
}

function openFind(view, replace) {
  // A word or one-line selection becomes the search, as in VS Code.
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (!sel.empty && text.length < 200 && !text.includes("\n")) {
    const query = getSearchQuery(view.state);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query.regexp ? text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : text, replace: query.replace, caseSensitive: query.caseSensitive, regexp: query.regexp, wholeWord: query.wholeWord })) });
  }
  openSearchPanel(view);
  const panel = panels.get(view);
  if (panel) replace ? panel.focusReplace() : panel.focusFind();
  return true;
}

/** The whole file's text, changed by only the part that differs, so carets, folds and history follow. */
function diffChange(before, after, offset) {
  const max = Math.min(before.length, after.length);
  let a = 0;
  while (a < max && before.charCodeAt(a) === after.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && before.charCodeAt(before.length - 1 - b) === after.charCodeAt(after.length - 1 - b)) b++;
  return { from: offset + a, to: offset + before.length - b, insert: after.slice(a, after.length - b) };
}

/**
 * Make the editor in parent. opts: { doc, kind, lang, name, indent, wrap, onUpdate(update), onWrap(on) }.
 * Returns the page's handle on it.
 */
function create(opts) {
  const language = new Compartment();
  const wrapping = new Compartment();
  const indenting = new Compartment();
  let saved = Text.of(String(opts.doc || "").split("\n"));
  let wrap = Boolean(opts.wrap);

  function languageExt(kind, lang, name, length) {
    return length > LANGUAGE_MAX ? [] : languageFor(kind, lang, name);
  }
  function toggleWrap(view) {
    wrap = !wrap;
    view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    if (opts.onWrap) opts.onWrap(wrap);
    return true;
  }
  function insertIndent(view) {
    const state = view.state;
    if (state.selection.ranges.some((range) => !range.empty && state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number)) {
      return indentMore(view);
    }
    view.dispatch(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: "input" });
    return true;
  }

  // First wins: the VS Code-style keys before CodeMirror's defaults. Ctrl+L, Ctrl+Shift+L and Ctrl+K
  // stay Scribe's (chat), so select-line is Alt+L and select-all-matches is Ctrl+F2 / Alt+Enter.
  const keys = [
    { key: "Tab", run: insertIndent, shift: indentLess },
    { key: "Mod-f", run: (v) => openFind(v, false), scope: "editor search-panel", preventDefault: true },
    { key: "Mod-h", run: (v) => openFind(v, true), scope: "editor search-panel", preventDefault: true },
    { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
    { key: "Mod-g", run: gotoLine, preventDefault: true },
    { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
    { key: "Mod-F2", run: selectSelectionMatchesFromQuery, preventDefault: true },
    { key: "Alt-Enter", run: selectSelectionMatchesFromQuery },
    { key: "Alt-z", run: toggleWrap, preventDefault: true },
    { key: "Mod-Shift-Enter", run: (v) => { // insert a line above, as VS Code does
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const indent = /^\s*/.exec(line.text)[0];
      v.dispatch({ changes: { from: line.from, insert: indent + "\n" }, selection: { anchor: line.from + indent.length }, scrollIntoView: true, userEvent: "input" });
      return true;
    } },
  ];

  const state = EditorState.create({
    doc: saved,
    extensions: [
      lineNumbers(),
      foldGutter({ markerDOM: (open) => { const s = document.createElement("span"); s.textContent = open ? "⌄" : "›"; return s; } }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of((event) => event.altKey && !event.shiftKey),
      rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
      indentOnInput(),
      syntaxHighlighting(highlight, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true, createPanel: findPanel }),
      EditorState.tabSize.of(4),
      indenting.of(indentUnit.of(opts.indent || "  ")),
      language.of(languageExt(opts.kind, opts.lang, opts.name, saved.length)),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      keymap.of([...keys, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": "File text" }),
      theme,
      EditorView.updateListener.of((update) => { if (opts.onUpdate) opts.onUpdate(update); }),
    ],
  });
  const view = new EditorView({ state, parent: opts.parent });

  function apply(change, userEvent, isolate) {
    if (change.from === change.to && !change.insert) return;
    const annotations = [Transaction.userEvent.of(userEvent)];
    if (isolate) annotations.push(isolateHistory.of("full"));
    view.dispatch({ changes: change, annotations });
  }

  return {
    view,
    text() { return view.state.doc.toString(); },
    length() { return view.state.doc.length; },
    /** Replace the whole text as one undoable step (a reload from disk, Prettify, a restored draft). */
    setText(text, userEvent) { apply(diffChange(view.state.doc.toString(), text, 0), userEvent || "input.replace", true); },
    /** Replace from..to (a markdown block's text as it is typed). */
    replaceRange(from, to, text) { apply(diffChange(view.state.sliceDoc(from, to), text, from), "input.type", false); },
    setSaved(text) { saved = Text.of(String(text).split("\n")); },
    isDirty() { const doc = view.state.doc; return doc.length !== saved.length || !doc.eq(saved); },
    configure(o) {
      view.dispatch({ effects: [
        language.reconfigure(languageExt(o.kind, o.lang, o.name, view.state.doc.length)),
        indenting.reconfigure(indentUnit.of(o.indent || "  ")),
      ] });
    },
    setWrap(on) { if (Boolean(on) !== wrap) toggleWrap(view); },
    wrap() { return wrap; },
    toggleWrap() { return toggleWrap(view); },
    undo() { return undo(view); },
    focus() { if (!view.hasFocus) view.focus(); },
    hasFocus() { return view.hasFocus; },
    select(anchor, head) {
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(anchor, len), head: Math.min(head === undefined ? anchor : head, len) } });
    },
    /** Line, column and selection size for the status bar. */
    position() {
      const sel = view.state.selection;
      const head = sel.main.head;
      const line = view.state.doc.lineAt(head);
      let selected = 0;
      for (const range of sel.ranges) selected += range.to - range.from;
      return { line: line.number, col: head - line.from + 1, selected, ranges: sel.ranges.length };
    },
    /** Run the editor's binding for a key Scribe would otherwise take (Ctrl+D, Ctrl+H). */
    runKey(event) {
      const scope = event.target && event.target.closest && event.target.closest(".cm-panels") ? "search-panel" : "editor";
      return runScopeHandlers(view, event, scope);
    },
    destroy() { view.destroy(); },
  };
}

window.ScribeEditor = { create };
