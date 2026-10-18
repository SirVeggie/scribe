/** Longest query the picker searches for: past it, the @ was not a mention. */
export const MENTION_QUERY_MAX = 60;

/** The @ or # token around the caret. Keep in sync with mentionAt in public/agent.js. */
export function mentionAt(value: string, cursor: number, prefix = "@", floor = 0): { start: number; end: number; query: string } | null {
  const before = value.slice(floor, cursor);
  const m = (prefix === "#" ? /(^|\s)#((?:[^\s#][^#\n]*)?)$/ : /(^|\s)@((?:[^\s@][^@\n]*)?)$/).exec(before);
  if (!m || m[2].length > MENTION_QUERY_MAX) return null;
  const start = cursor - 1 - m[2].length;
  if (start > 0 && !/\s/.test(value[start - 1])) return null;
  const rest = (prefix === "#" ? /^[^\s#]*/ : /^[^\s@]*/).exec(value.slice(cursor))?.[0] || "";
  return { start, end: cursor + rest.length, query: m[2] };
}
