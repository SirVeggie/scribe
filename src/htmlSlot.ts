/**
 * Place an agent's inner HTML into a starter page: the first [data-slot], else <main>, else <body>.
 * Matching close tags count nested tags of the same name; comments and the raw contents of
 * <script>, <style>, and <textarea> are skipped so markup inside them does not affect depth.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea"]);
const NAME = /[A-Za-z][\w:.-]*/;

export class HtmlSlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlSlotError";
  }
}

type OpenTag = {
  name: string;
  start: number;
  end: number;
  selfClosing: boolean;
  attrs: string;
};

export function spliceHtmlSlot(baseHtml: string, inner: string): string {
  const open = findTarget(baseHtml);
  const close = findMatchingClose(baseHtml, open);
  return baseHtml.slice(0, open.end) + inner + baseHtml.slice(close.start);
}

function findTarget(html: string): OpenTag {
  let main: OpenTag | undefined;
  let body: OpenTag | undefined;
  let i = 0;
  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) break;
    i = next;
    if (html.startsWith("<!--", i)) {
      i = skipComment(html, i);
      continue;
    }
    const close = parseCloseTag(html, i);
    if (close) {
      i = close.end;
      continue;
    }
    const open = parseOpenTag(html, i);
    if (!open) {
      i += 1;
      continue;
    }
    if (hasAttr(open.attrs, "data-slot")) return open;
    if (open.name === "main" && !main) main = open;
    if (open.name === "body" && !body) body = open;
    if (RAW.has(open.name) && !open.selfClosing) {
      const rawClose = findRawClose(html, open.end, open.name);
      i = rawClose ? rawClose.end : html.length;
      continue;
    }
    i = open.end;
  }
  const target = main ?? body;
  if (!target) {
    throw new HtmlSlotError("The base page has no data-slot, <main>, or <body> to place html in.");
  }
  return target;
}

function findMatchingClose(html: string, open: OpenTag): { start: number; end: number } {
  if (open.selfClosing) {
    throw new HtmlSlotError(`The base page's slot is a void <${open.name}>; it has no inner content to replace.`);
  }
  if (RAW.has(open.name)) {
    const close = findRawClose(html, open.end, open.name);
    if (!close) throw unclosed(open.name);
    return close;
  }
  let depth = 1;
  let i = open.end;
  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) break;
    i = next;
    if (html.startsWith("<!--", i)) {
      i = skipComment(html, i);
      continue;
    }
    const close = parseCloseTag(html, i);
    if (close) {
      if (close.name === open.name) {
        depth -= 1;
        if (depth === 0) return { start: i, end: close.end };
      }
      i = close.end;
      continue;
    }
    const nested = parseOpenTag(html, i);
    if (!nested) {
      i += 1;
      continue;
    }
    if (RAW.has(nested.name) && !nested.selfClosing) {
      const rawClose = findRawClose(html, nested.end, nested.name);
      i = rawClose ? rawClose.end : html.length;
      continue;
    }
    if (nested.name === open.name && !nested.selfClosing) depth += 1;
    i = nested.end;
  }
  throw unclosed(open.name);
}

function unclosed(name: string): HtmlSlotError {
  return new HtmlSlotError(`The base page's <${name}> slot is not closed.`);
}

function skipComment(html: string, i: number): number {
  const end = html.indexOf("-->", i + 4);
  return end === -1 ? html.length : end + 3;
}

function skipQuoted(html: string, i: number): number {
  const q = html[i];
  const end = html.indexOf(q, i + 1);
  return end === -1 ? html.length : end + 1;
}

function parseOpenTag(html: string, i: number): OpenTag | null {
  if (html[i] !== "<" || html[i + 1] === "/" || html[i + 1] === "!" || html[i + 1] === "?") return null;
  const nameMatch = NAME.exec(html.slice(i + 1));
  if (!nameMatch || nameMatch.index !== 0) return null;
  const name = nameMatch[0].toLowerCase();
  let j = i + 1 + nameMatch[0].length;
  while (j < html.length) {
    const c = html[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(html, j);
      continue;
    }
    if (c === ">") {
      const attrs = html.slice(i + 1 + nameMatch[0].length, j);
      const selfClosing = VOID.has(name) || /\/\s*$/.test(attrs);
      return { name, start: i, end: j + 1, selfClosing, attrs };
    }
    j += 1;
  }
  return null;
}

function parseCloseTag(html: string, i: number): { name: string; end: number } | null {
  if (!html.startsWith("</", i)) return null;
  const nameMatch = NAME.exec(html.slice(i + 2));
  if (!nameMatch || nameMatch.index !== 0) return null;
  let j = i + 2 + nameMatch[0].length;
  while (j < html.length && /\s/.test(html[j])) j += 1;
  if (html[j] !== ">") return null;
  return { name: nameMatch[0].toLowerCase(), end: j + 1 };
}

function findRawClose(html: string, from: number, name: string): { start: number; end: number } | null {
  const re = new RegExp(`</${name}\\s*>`, "i");
  const match = re.exec(html.slice(from));
  if (!match) return null;
  return { start: from + match.index, end: from + match.index + match[0].length };
}

/** Attribute names only, so a quoted value containing the name (or `>`) does not count. */
function hasAttr(attrs: string, name: string): boolean {
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && /\s/.test(attrs[i])) i += 1;
    if (i >= attrs.length || attrs[i] === "/") break;
    let j = i;
    while (j < attrs.length && !/[\s=/]/.test(attrs[j])) j += 1;
    const attrName = attrs.slice(i, j).toLowerCase();
    i = j;
    if (attrs[i] === "=") {
      i += 1;
      while (i < attrs.length && /\s/.test(attrs[i])) i += 1;
      if (attrs[i] === '"' || attrs[i] === "'") i = skipQuoted(attrs, i);
      // An unquoted value runs to whitespace, slashes included (href=/a/b).
      else while (i < attrs.length && !/\s/.test(attrs[i])) i += 1;
    }
    if (attrName === name) return true;
  }
  return false;
}
