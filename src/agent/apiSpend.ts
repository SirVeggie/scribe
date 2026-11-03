import { isPlainRecord, type ApiBalance, type Turn } from "./types.js";

/** The local day (YYYY-MM-DD) of a time. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The API a Native model id runs on: its part before "/" ("deepseek/deepseek-flash" → "deepseek"). */
export function nativeApi(model: string): string | null {
  const at = model.indexOf("/");
  return at > 0 ? model.slice(0, at) : null;
}

/** Today's cost of Native turns by API (#980): turns started since local midnight, reverted ones left out. */
export function todaysSpend(turnLists: Iterable<ReadonlyArray<Pick<Turn, "model" | "startedAt" | "usage" | "reverted">>>, now = Date.now()): Map<string, number> {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const out = new Map<string, number>();
  for (const turns of turnLists) {
    for (const turn of turns) {
      const cost = turn.usage?.costUsd;
      if (turn.reverted || turn.startedAt < midnight || !(typeof cost === "number" && cost > 0)) continue;
      const api = nativeApi(turn.model);
      if (api) out.set(api, (out.get(api) ?? 0) + cost);
    }
  }
  return out;
}

const amount = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);

/** DeepSeek's GET /user/balance body: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }. */
export function parseDeepSeekBalance(body: unknown, at = Date.now()): ApiBalance | null {
  if (!isPlainRecord(body) || !Array.isArray(body.balance_infos)) return null;
  const amounts: ApiBalance["amounts"] = [];
  for (const info of body.balance_infos) {
    if (!isPlainRecord(info) || typeof info.currency !== "string") continue;
    const total = amount(info.total_balance);
    if (!total) continue;
    const granted = amount(info.granted_balance);
    const toppedUp = amount(info.topped_up_balance);
    amounts.push({ currency: info.currency, total, ...(granted ? { granted } : {}), ...(toppedUp ? { toppedUp } : {}) });
  }
  return { at, available: body.is_available === true, amounts };
}

/** Ask DeepSeek for the account's balance. The key goes only to api.deepseek.com. */
export async function fetchDeepSeekBalance(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ApiBalance | null> {
  const res = await fetchImpl("https://api.deepseek.com/user/balance", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DeepSeek balance: HTTP ${res.status}`);
  return parseDeepSeekBalance(await res.json());
}
