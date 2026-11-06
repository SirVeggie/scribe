import type express from "express";
import { widgetStateAllowed, type PluginManifest } from "./manifest.js";
import type { PluginService } from "./service.js";

export type WidgetRate = { at: number; count: number; active: number };

/** Count every request, including ones awaiting consent, against the same limits. */
export async function limitWidgetAction<T>(rate: WidgetRate, action: () => T | Promise<T>): Promise<T> {
  const now = Date.now();
  if (now - rate.at >= 1000) { rate.at = now; rate.count = 0; }
  if (++rate.count > 100 || rate.active >= 16) throw new Error("Widget plugin requests are too frequent.");
  rate.active++;
  try { return await action(); }
  finally { rate.active--; }
}

// A shared tick retains revocation for all host-specific validity conditions
// (including turn completion and mount eviction) without a timer per stream.
const streams = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function poll(check: () => void): () => void {
  streams.add(check);
  timer ??= setInterval(() => { for (const tick of streams) tick(); }, 1000);
  return () => {
    streams.delete(check);
    if (!streams.size) { clearInterval(timer); timer = undefined; }
  };
}

// A write past the socket's high-water mark returns false without the client
// being slow, so wait for drain and close only when the client stays behind.
export const SLOW_CLIENT = { bufferBytes: 1024 * 1024, drainMs: 15_000 };

export function relayWidgetEvents(res: express.Response, options: {
  plugins: Pick<PluginService, "subscribe">;
  plugin: string;
  definition: Pick<PluginManifest["widgets"][string], "state" | "events">;
  valid: () => boolean;
}): void {
  const { plugins, plugin, definition, valid } = options;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
  res.flushHeaders();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let unpoll: (() => void) | undefined;
  let blockedSince: number | undefined;
  const drained = () => { blockedSince = undefined; };
  // A client that stopped reading would never take the rest, so drop it instead of ending.
  const close = (drop?: unknown) => {
    if (closed) return;
    closed = true;
    unsubscribe?.(); unpoll?.();
    res.off("close", close);
    res.off("drain", drained);
    if (drop === true) res.destroy(); else res.end();
  };
  const write = (chunk: string) => {
    if (closed || res.write(chunk)) return;
    if (res.writableLength > SLOW_CLIENT.bufferBytes) close(true);
    else blockedSince ??= Date.now();
  };
  const send = (data: unknown) => write(`data: ${JSON.stringify(data)}\n\n`);
  const reload = () => { send({ type: "reload" }); close(); };
  unsubscribe = plugins.subscribe((id, name, data, registry) => {
    if (closed || (id !== plugin && id !== "*")) return;
    if (registry || !valid()) { reload(); return; }
    if (name === "state") {
      const state = data as { key?: unknown; revision?: unknown };
      if (typeof state?.key === "string" && widgetStateAllowed(definition.state, state.key)) send({ type: "plugin-state", key: state.key, revision: state.revision });
    } else if (definition.events.includes(name) && Buffer.byteLength(JSON.stringify(data) ?? "null") <= 64 * 1024) send({ type: "plugin-event", name, data });
  });
  unpoll = poll(() => {
    if (!valid()) reload();
    else if (blockedSince === undefined) write(": keepalive\n\n");
    else if (Date.now() - blockedSince >= SLOW_CLIENT.drainMs) close(true);
  });
  res.on("close", close);
  res.on("drain", drained);
  send({ type: "ready" });
}
