import { cleanServer, validName, type McpServer } from "../agent/mcpConfig.js";
import { pluginId } from "../plugins/manifest.js";

/**
 * Offers (#1024): MCP servers and plugins another device has and this one doesn't. Each device sends a
 * list of its own with the settings sync messages; the other shows what it lacks, to add with a click.
 * Nothing is installed on its own: a server runs code and its command or paths may differ per device,
 * and a plugin goes through the review that copies already use (#907).
 *
 * Only global MCP servers are offered (workspace layers name this device's folders), without their
 * working folder. Environment values and headers often hold tokens: they go only with Include keys,
 * except plain ${VAR} references, and the offer lists the ones left out.
 */

export type McpOffer = { name: string; server: McpServer; withheld?: string[] };
export type PluginOffer = { id: string; name: string; version: string };
export type Inventory = { mcp: McpOffer[]; plugins: PluginOffer[] };

export type OffersState = {
  /** The last inventory from each device. */
  devices: Record<string, { name: string; at: number; inventory: Inventory }>;
  /** Offers the user dismissed, as "mcp:<name>" or "plugin:<id>". */
  dismissed: string[];
  /** Offers a notice was shown for already. */
  seen: string[];
};

export type Offer = { kind: "mcp" | "plugin"; id: string; label: string; detail: string; from: { id: string; name: string }; withheld?: string[] };

export const emptyOffers = (): OffersState => ({ devices: {}, dismissed: [], seen: [] });

const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** This device's servers as an offer: global ones only, without a working folder, and secrets only when asked. */
export function mcpInventory(servers: Record<string, McpServer>, includeSecrets: boolean): McpOffer[] {
  const out: McpOffer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw.command && !raw.url) continue;
    const server: McpServer = { ...raw };
    delete server.cwd;
    const withheld: string[] = [];
    for (const field of ["env", "headers"] as const) {
      const map = server[field];
      if (!map || includeSecrets) continue;
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(map)) {
        if (REFERENCE.test(v)) kept[k] = v;
        else withheld.push(k);
      }
      if (Object.keys(kept).length) server[field] = kept;
      else delete server[field];
    }
    out.push({ name, server, ...(withheld.length ? { withheld } : {}) });
  }
  return out.slice(0, 100);
}

export function cleanInventory(raw: unknown): Inventory | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Partial<Inventory>;
  const mcp: McpOffer[] = [];
  for (const item of Array.isArray(input.mcp) ? input.mcp.slice(0, 100) : []) {
    const server = cleanServer(item?.server);
    if (!item || typeof item.name !== "string" || !validName(item.name) || !server || (!server.command && !server.url)) continue;
    delete server.cwd;
    const withheld = Array.isArray(item.withheld) ? item.withheld.filter((k): k is string => typeof k === "string").slice(0, 50) : [];
    mcp.push({ name: item.name, server, ...(withheld.length ? { withheld } : {}) });
  }
  const plugins: PluginOffer[] = [];
  for (const item of Array.isArray(input.plugins) ? input.plugins.slice(0, 200) : []) {
    if (!item || typeof item.id !== "string" || !pluginId.safeParse(item.id).success) continue;
    plugins.push({ id: item.id, name: String(item.name ?? item.id).slice(0, 100), version: String(item.version ?? "").slice(0, 40) });
  }
  return { mcp, plugins };
}

export function cleanOffers(raw: unknown): OffersState {
  const base = emptyOffers();
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<OffersState>;
  for (const [id, entry] of Object.entries(input.devices ?? {})) {
    const inventory = cleanInventory(entry?.inventory);
    if (inventory && typeof entry.name === "string") base.devices[id] = { name: entry.name, at: Number(entry.at) || 0, inventory };
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(-500) : []);
  base.dismissed = strings(input.dismissed);
  base.seen = strings(input.seen);
  return base;
}

const offerId = (kind: Offer["kind"], id: string) => `${kind}:${id}`;

/** What the other devices have and this one doesn't, one offer per server name or plugin id. */
export function listOffers(state: OffersState, has: (kind: Offer["kind"], id: string) => boolean, paired: (id: string) => string | undefined): Offer[] {
  const out: Offer[] = [];
  const taken = new Set<string>();
  const devices = Object.entries(state.devices).sort(([, a], [, b]) => b.at - a.at);
  for (const [deviceId, entry] of devices) {
    const name = paired(deviceId);
    if (!name) continue;
    const from = { id: deviceId, name };
    for (const item of entry.inventory.mcp) {
      const id = offerId("mcp", item.name);
      if (taken.has(id) || state.dismissed.includes(id) || has("mcp", item.name)) continue;
      taken.add(id);
      const detail = item.server.url ?? [item.server.command, ...(item.server.args ?? [])].join(" ");
      out.push({ kind: "mcp", id: item.name, label: item.name, detail, from, ...(item.withheld ? { withheld: item.withheld } : {}) });
    }
    for (const item of entry.inventory.plugins) {
      const id = offerId("plugin", item.id);
      if (taken.has(id) || state.dismissed.includes(id) || has("plugin", item.id)) continue;
      taken.add(id);
      out.push({ kind: "plugin", id: item.id, label: item.name, detail: item.version, from });
    }
  }
  return out;
}

/** Offers no notice was shown for yet, grouped by device; marks them seen. */
export function newOffers(state: OffersState, offers: Offer[]): { state: OffersState; notices: { from: { id: string; name: string }; mcp: number; plugins: number }[] } {
  const fresh = offers.filter((o) => !state.seen.includes(offerId(o.kind, o.id)));
  if (!fresh.length) return { state, notices: [] };
  const byDevice = new Map<string, { from: { id: string; name: string }; mcp: number; plugins: number }>();
  for (const offer of fresh) {
    const entry = byDevice.get(offer.from.id) ?? { from: offer.from, mcp: 0, plugins: 0 };
    if (offer.kind === "mcp") entry.mcp += 1;
    else entry.plugins += 1;
    byDevice.set(offer.from.id, entry);
  }
  return { state: { ...state, seen: [...state.seen, ...fresh.map((o) => offerId(o.kind, o.id))].slice(-500) }, notices: [...byDevice.values()] };
}
