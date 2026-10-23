import type express from "express";
import { componentStateAllowed, type PluginManifest } from "./manifest.js";
import type { PluginService } from "./service.js";

export type ComponentRate = { at: number; count: number; active: number };

/** Count every request, including ones awaiting consent, against the same limits. */
export async function limitComponentAction<T>(rate: ComponentRate, action: () => T | Promise<T>): Promise<T> {
  const now = Date.now();
  if (now - rate.at >= 1000) { rate.at = now; rate.count = 0; }
  if (++rate.count > 100 || rate.active >= 16) throw new Error("Component plugin requests are too frequent.");
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

export function relayComponentEvents(res: express.Response, options: {
  plugins: Pick<PluginService, "subscribe">;
  plugin: string;
  definition: Pick<PluginManifest["components"][string], "state" | "events">;
  valid: () => boolean;
}): void {
  const { plugins, plugin, definition, valid } = options;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
  res.flushHeaders();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let unpoll: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.(); unpoll?.();
    res.off("close", close);
    res.end();
  };
  const send = (data: unknown) => { if (!closed && !res.write(`data: ${JSON.stringify(data)}\n\n`)) close(); };
  const reload = () => { send({ type: "reload" }); close(); };
  unsubscribe = plugins.subscribe((id, name, data, registry) => {
    if (closed || (id !== plugin && id !== "*")) return;
    if (registry || !valid()) { reload(); return; }
    if (name === "state") {
      const state = data as { key?: unknown; revision?: unknown };
      if (typeof state?.key === "string" && componentStateAllowed(definition.state, state.key)) send({ type: "plugin-state", key: state.key, revision: state.revision });
    } else if (definition.events.includes(name) && Buffer.byteLength(JSON.stringify(data) ?? "null") <= 64 * 1024) send({ type: "plugin-event", name, data });
  });
  unpoll = poll(() => { if (!valid()) reload(); else if (!res.write(": keepalive\n\n")) close(); });
  res.on("close", close);
  send({ type: "ready" });
}
