import type { Item, ProviderId, Turn, Usage } from "./types.js";
import { promptTokens } from "./harness.js";

/**
 * Usage over time (#867): every kept turn of every thread, deleted ones included, grouped by day,
 * provider, model, workspace and board worker, plus the threads and Kanban cards that cost the most.
 * Each turn counts once, in the thread that ran it; helper chats roll up into the thread (and card)
 * that started them only in the per-thread and per-card lists, so nothing is counted twice.
 */

/** Where a chat came from: the board worker that ran it and the card it was started on. */
export type ThreadOrigin = { worker?: string; card?: { board: string; num: number; title?: string } };

const WORKER_PROMPT = /^You are the agent worker "([^"\n]*)" on the Kanban board "[^\n]*" \(Scribe page id ([^)\s]+)\)/;
const CARD_LINE = /^Your card: #(\d+) (.*?)(?: \(too long to include here: get it first\))?$/m;

/** The worker and card of a board worker's chat (kanbanWorkers.ts workerPrompt), or of a chat a card's comment or Continue reached. */
export function threadOrigin(items: Item[], board: string | null): ThreadOrigin {
  for (const item of items) {
    if (item.kind !== "user") continue;
    const worker = item.from === "page" ? WORKER_PROMPT.exec(item.text) : null;
    if (worker) {
      const card = CARD_LINE.exec(item.text);
      return { ...(worker[1] ? { worker: worker[1] } : {}), ...(card ? { card: { board: worker[2], num: Number(card[1]), title: card[2] } } : {}) };
    }
    if (item.card && board) return { card: { board, num: item.card.num, ...(item.card.title ? { title: item.card.title } : {}) } };
  }
  return {};
}

export type UsageTotals = {
  turns: number;
  /** Everything sent, cached input included exactly once (promptTokens). */
  prompt: number;
  /** Sent and not read from or written to the cache. */
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  estimatedCostUsd: number;
  reportedCostUsd: number;
  unpricedTurns: number;
};

/** One group of turns: a day, and the provider, model, workspace and worker they ran under. */
export type UsageRow = UsageTotals & {
  day: string;
  provider: ProviderId;
  model: string;
  workspace: string | null;
  worker: string | null;
  /** Turns of helper chats among them. */
  helperTurns: number;
};

export type UsageThreadRow = UsageTotals & {
  id: string;
  /** Missing for threads deleted with their workspace. */
  title?: string;
  provider: ProviderId;
  model: string;
  workspace: string | null;
  worker: string | null;
  card?: { board: string; boardTitle?: string; num: number; title?: string };
  /** Helper chats whose turns are included. */
  helpers: number;
};

export type UsageCardRow = UsageTotals & { board: string; boardTitle?: string; num: number; title?: string; threads: number; workers: string[] };

export type UsageHistory = {
  since: number | null;
  rows: UsageRow[];
  /** How much of each plan window the turns used, summed per day (Claude reports it per turn). */
  plan: Array<{ day: string; id: string; label: string; used: number }>;
  threads: UsageThreadRow[];
  cards: UsageCardRow[];
};

export type UsageSource = {
  id: string;
  title?: string;
  helperOf?: string;
  provider: ProviderId;
  workspace: string | null;
  origin: ThreadOrigin;
  turns: Array<Pick<Turn, "id" | "model" | "startedAt" | "usage" | "reverted">>;
};

export const emptyUsage = (): UsageTotals => ({ turns: 0, prompt: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, estimatedCostUsd: 0, reportedCostUsd: 0, unpricedTurns: 0 });

/** A turn's numbers in the shape every list adds up. */
export function turnUsage(provider: ProviderId, usage: Usage | undefined): UsageTotals {
  const prompt = promptTokens(provider, usage);
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    turns: 1,
    prompt,
    fresh: Math.max(0, prompt - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    costUsd: usage?.costUsd ?? 0,
    estimatedCostUsd: usage?.estimatedCostUsd ?? 0,
    reportedCostUsd: usage?.reportedCostUsd ?? 0,
    unpricedTurns: usage?.costUsd === undefined ? 1 : 0,
  };
}

export function addTotals(into: UsageTotals, part: UsageTotals): void {
  for (const key of Object.keys(part) as Array<keyof UsageTotals>) into[key] += part[key];
}

export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The thread a helper (or a helper's helper) works for; itself when it is no helper. */
function rootOf(id: string, byId: Map<string, UsageSource>): UsageSource | undefined {
  let source = byId.get(id);
  const seen = new Set<string>();
  while (source?.helperOf && !seen.has(source.id) && byId.has(source.helperOf)) {
    seen.add(source.id);
    source = byId.get(source.helperOf);
  }
  return source;
}

const TOP = 25;

export function usageHistory(
  sources: UsageSource[],
  since: number | null,
  boardTitle: (board: string) => string | undefined = () => undefined,
  cardTitle: (board: string, num: number) => string | undefined = () => undefined,
): UsageHistory {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const rows = new Map<string, UsageRow>();
  const plan = new Map<string, UsageHistory["plan"][number]>();
  const threads = new Map<string, UsageThreadRow>();
  const cards = new Map<string, UsageCardRow & { ids: Set<string>; names: Set<string> }>();

  for (const source of sources) {
    const turns = source.turns.filter((t) => !t.reverted && (since === null || t.startedAt >= since));
    if (!turns.length) continue;
    const root = rootOf(source.id, byId) ?? source;
    const helper = root.id !== source.id;
    const worker = root.origin.worker ?? source.origin.worker ?? null;
    const card = root.origin.card ?? source.origin.card;
    const thread = threads.get(root.id) ?? (() => {
      const made: UsageThreadRow = {
        ...emptyUsage(), id: root.id, ...(root.title !== undefined ? { title: root.title } : {}), provider: root.provider, model: root.turns.at(-1)?.model ?? "",
        workspace: root.workspace, worker, helpers: 0,
        ...(card ? { card: { ...card, ...(boardTitle(card.board) ? { boardTitle: boardTitle(card.board) } : {}), ...(cardTitle(card.board, card.num) ? { title: cardTitle(card.board, card.num) } : {}) } } : {}),
      };
      threads.set(root.id, made);
      return made;
    })();
    if (helper) thread.helpers += 1;
    const cardRow = card && (cards.get(`${card.board}\n${card.num}`) ?? (() => {
      const title = cardTitle(card.board, card.num) ?? card.title;
      const made = { ...emptyUsage(), board: card.board, ...(boardTitle(card.board) ? { boardTitle: boardTitle(card.board) } : {}), num: card.num, ...(title ? { title } : {}), threads: 0, workers: [], ids: new Set<string>(), names: new Set<string>() };
      cards.set(`${card.board}\n${card.num}`, made);
      return made;
    })());
    if (cardRow) {
      cardRow.ids.add(source.id);
      if (worker) cardRow.names.add(worker);
    }
    for (const turn of turns) {
      const usage = turnUsage(source.provider, turn.usage);
      const day = dayKey(turn.startedAt);
      const key = [day, source.provider, turn.model, source.workspace ?? "", worker ?? ""].join("\n");
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { ...emptyUsage(), day, provider: source.provider, model: turn.model, workspace: source.workspace, worker, helperTurns: 0 }));
      addTotals(row, usage);
      if (helper) row.helperTurns += 1;
      addTotals(thread, usage);
      if (cardRow) addTotals(cardRow, usage);
      for (const window of turn.usage?.plan ?? []) {
        if (!(window.used > 0)) continue;
        const entry = plan.get(`${day}\n${window.id}`) ?? { day, id: window.id, label: window.label, used: 0 };
        entry.used += window.used;
        plan.set(`${day}\n${window.id}`, entry);
      }
    }
  }

  const byCost = <T extends UsageTotals>(a: T, b: T) => b.costUsd - a.costUsd || b.prompt - a.prompt;
  return {
    since,
    rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || b.costUsd - a.costUsd),
    plan: [...plan.values()].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)),
    threads: [...threads.values()].sort(byCost).slice(0, TOP),
    cards: [...cards.values()]
      .map(({ ids, names, ...row }) => ({ ...row, threads: ids.size, workers: [...names].sort() }))
      .sort(byCost)
      .slice(0, TOP),
  };
}

const CSV_COLUMNS = [
  "date", "time", "thread", "root_thread", "helper", "provider", "model", "workspace", "worker", "board", "card",
  "prompt_tokens", "uncached_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens",
  "cost_usd", "reported_cost_usd", "estimated_cost_usd", "cost_known",
] as const;

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line per kept turn, oldest first, for querying elsewhere. */
export function usageCsv(sources: UsageSource[], since: number | null): string {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const lines: Array<{ at: number; cells: Array<string | number | null> }> = [];
  for (const source of sources) {
    const root = rootOf(source.id, byId) ?? source;
    const card = root.origin.card ?? source.origin.card;
    for (const turn of source.turns) {
      if (turn.reverted || (since !== null && turn.startedAt < since)) continue;
      const u = turnUsage(source.provider, turn.usage);
      const d = new Date(turn.startedAt);
      lines.push({
        at: turn.startedAt,
        cells: [
          dayKey(turn.startedAt), `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`,
          source.id, root.id, root.id === source.id ? 0 : 1, source.provider, turn.model, source.workspace, root.origin.worker ?? source.origin.worker ?? null,
          card?.board ?? null, card?.num ?? null,
          u.prompt, u.fresh, u.cacheRead, u.cacheWrite, u.output, u.reasoning,
          turn.usage?.costUsd ?? null, turn.usage?.reportedCostUsd ?? null, turn.usage?.estimatedCostUsd ?? null, u.unpricedTurns ? 0 : 1,
        ],
      });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  return [CSV_COLUMNS.join(","), ...lines.map((line) => line.cells.map(csvCell).join(","))].join("\r\n") + "\r\n";
}
