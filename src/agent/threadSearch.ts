/** The thread menu's search over what was said in a thread: the user's messages and the agent's replies, not tool calls or thinking. */

export type MessageRow = { threadId: string; text: string };

export type ThreadMessageHit = {
  id: string;
  /** The query words this thread's messages mention. The client adds the words its title matches. */
  words: string[];
  /** Around the first word in the message that mentions the most of them. */
  snippet: string;
};

/** A query's words, lowercase: a thread matches when each is in its title or its messages, in any order. */
export function searchWords(q: unknown): string[] {
  const words = typeof q === "string" ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const useful = words.filter((word) => !QUERY_STOPWORDS.has(word));
  // A query made entirely of stopwords can still name something specific (e.g. C's "a").
  return [...new Set(useful.length ? useful : words)].slice(0, 10);
}

/** Same stopwords as library search; keep public/agent.js in sync. */
const QUERY_STOPWORDS = new Set(["a", "an", "the", "my", "me", "your", "our", "page", "pages", "tab", "tabs", "board", "html", "list", "lists", "updated", "update", "please", "show"]);

/** LIKE folds case for ASCII only, so a word with other letters also gets its common case variants. */
function caseForms(word: string): string[] {
  return [...new Set(/[^\x00-\x7f]/.test(word) ? [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)] : [word])];
}

const likeEscape = (text: string) => `%${text.replace(/[!%_]/g, "!$&")}%`;

/** SQL LIKE patterns (ESCAPE '!') that find a word in an item's stored JSON. */
export function likePatterns(word: string): string[] {
  return caseForms(word).map((form) => likeEscape(JSON.stringify(form).slice(1, -1)));
}

/** SQL LIKE patterns (ESCAPE '!') that find a word in plain message text (the message_text table). */
export function textLikePatterns(word: string): string[] {
  return caseForms(word).map(likeEscape);
}

export function messageSnippet(text: string, word: string, width = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const at = Math.max(0, compact.toLowerCase().indexOf(word));
  const start = Math.max(0, at - 40);
  const end = Math.min(compact.length, start + width);
  return (start > 0 ? "…" : "") + compact.slice(start, end) + (end < compact.length ? "…" : "");
}

/** Rows come in thread order (oldest message first within a thread); threads with no word in any message are left out. */
export function matchMessages(rows: Iterable<MessageRow>, words: string[]): ThreadMessageHit[] {
  const found = new Map<string, { words: Set<string>; best: number; snippet: string }>();
  for (const row of rows) {
    let hit = found.get(row.threadId);
    // All words and the best possible snippet are already known for this thread.
    if (hit?.best === words.length) continue;
    const text = row.text.toLowerCase();
    const here = words.filter((word) => text.includes(word));
    if (!here.length) continue;
    if (!hit) found.set(row.threadId, (hit = { words: new Set(), best: 0, snippet: "" }));
    for (const word of here) hit.words.add(word);
    if (here.length > hit.best) {
      hit.best = here.length;
      hit.snippet = messageSnippet(row.text, here[0]);
    }
  }
  return [...found].map(([id, hit]) => ({ id, words: [...hit.words], snippet: hit.snippet }));
}
