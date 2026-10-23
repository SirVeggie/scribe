import { randomBytes } from "node:crypto";
import type express from "express";
import type { BoardStore } from "./store.js";
import type { PluginService } from "./plugins/service.js";
import { componentStateAllowed } from "./plugins/manifest.js";
import { checkPermission } from "./pagePermissions.js";
import { componentJson, componentLink, parseComponentInput } from "./agent/componentTool.js";
import { pageComponentHost, PORT } from "./config.js";

type Mount = { id: string; page: string; revision: number; plugin: string; component: string; props: unknown; local: Record<string, unknown>; hash: string; token: string; diagnostics: boolean; capture: boolean; touched: number; at: number; count: number; active: number };

/** Ephemeral page mounts. Identity, revision and declarations are checked again on every operation. */
export class PageComponents {
  private mounts = new Map<string, Mount>();
  constructor(private store: Pick<BoardStore, "get" | "pagePermissions">, private plugins: PluginService) {}

  release(page: string, id: string) { if (this.mounts.get(id)?.page === page) this.mounts.delete(id); }

  private evict(page?: string) {
    const oldest = [...this.mounts.values()].filter(mount => !page || mount.page === page).sort((a, b) => a.touched - b.touched)[0];
    if (oldest) this.mounts.delete(oldest.id);
  }

  resolve(page: string, input: Record<string, unknown>) {
    const tab = this.store.get(page);
    if (!tab) throw new Error("Page not found.");
    for (const [id, mount] of this.mounts) if (mount.page === page && mount.revision !== tab.revision) this.mounts.delete(id);
    const spec = parseComponentInput({ plugin: input.plugin, component: input.component, props: input.props });
    const current = this.plugins.component(spec.plugin!, spec.component!, spec.props);
    if (checkPermission(this.store.pagePermissions(page), { perm: `plugin.${spec.plugin}` }) === "deny") throw new Error("This page denies the plugin.");
    const id = `pc_${randomBytes(8).toString("hex")}`;
    const local = componentJson(input.local ?? {});
    if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("Component local state must be an object.");
    if ([...this.mounts.values()].filter(mount => mount.page === page).length >= 64) this.evict(page);
    if (this.mounts.size >= 500) this.evict();
    const mount: Mount = { id, page, revision: tab.revision, plugin: spec.plugin!, component: spec.component!, props: spec.props, local: local as Record<string, unknown>, hash: current.hash, token: randomBytes(16).toString("hex"), diagnostics: input.diagnostics === true, capture: input.capture === true, touched: Date.now(), at: Date.now(), count: 0, active: 0 };
    this.mounts.set(id, mount);
    return { id, token: mount.token, height: current.definition.height, url: `http://${pageComponentHost(id)}:${PORT}/component/${id}?page=${encodeURIComponent(page)}` };
  }

  current(page: string, id: string, allowed = true) {
    const mount = this.mounts.get(id), tab = this.store.get(page);
    if (!mount || mount.page !== page || !tab || tab.revision !== mount.revision) throw new Error("Component page changed or mount expired.");
    const permission = checkPermission(this.store.pagePermissions(page), { perm: `plugin.${mount.plugin}` });
    if (permission === "deny") throw new Error("This page denies the plugin.");
    if (allowed && permission !== "allow") throw new Error("permission");
    const current = this.plugins.component(mount.plugin, mount.component, mount.props);
    if (current.hash !== mount.hash) throw new Error("Plugin changed; reload the page.");
    mount.touched = Date.now();
    return { ...current, mount };
  }

  async action(page: string, id: string, input: Record<string, unknown>) {
    const { definition, mount } = this.current(page, id);
    if (Date.now() - mount.at >= 1000) { mount.at = Date.now(); mount.count = 0; }
    if (++mount.count > 100 || mount.active >= 16) throw new Error("Component plugin requests are too frequent.");
    const key = String(input.key ?? ""), method = String(input.method ?? "");
    if (input.op === "open") return { link: componentLink(input.link) };
    if (input.op === "state") {
      if (!key || key.length > 200 || !componentStateAllowed(definition.state, key)) throw new Error("Component state key is not declared.");
      return this.plugins.database.get(mount.plugin, key);
    }
    if (input.op === "listen") {
      if (!definition.events.length && !definition.state.length) throw new Error("Component has no live declarations.");
      return { ok: true };
    }
    if (input.op === "subscribe") {
      if (!definition.events.includes(String(input.event))) throw new Error("Component event is not declared.");
      return { ok: true };
    }
    if (input.op !== "call" || !definition.methods.includes(method)) throw new Error("Component method is not declared.");
    mount.active++;
    try { return await this.plugins.call(mount.plugin, method, componentJson(input.args ?? {}), { kind: "page", page }); }
    finally { mount.active--; }
  }

  events(page: string, id: string, res: express.Response) {
    const initial = this.current(page, id);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
    res.flushHeaders();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => { if (closed) return; closed = true; unsubscribe?.(); clearInterval(timer); res.end(); };
    const send = (data: unknown) => { if (!closed && !res.write(`data: ${JSON.stringify(data)}\n\n`)) close(); };
    const valid = () => { try { this.current(page, id); return true; } catch { return false; } };
    unsubscribe = this.plugins.subscribe((plugin, name, data, registry) => {
      if (plugin !== initial.mount.plugin && plugin !== "*") return;
      if (registry || !valid()) { send({ type: "reload" }); close(); return; }
      if (name === "state") {
        const state = data as { key?: unknown; revision?: unknown };
        if (typeof state?.key === "string" && componentStateAllowed(initial.definition.state, state.key)) send({ type: "plugin-state", key: state.key, revision: state.revision });
      } else if (initial.definition.events.includes(name) && Buffer.byteLength(JSON.stringify(data) ?? "null") <= 64 * 1024) send({ type: "plugin-event", name, data });
    });
    timer = setInterval(() => { if (!valid()) { send({ type: "reload" }); close(); } else res.write(": keepalive\n\n"); }, 1000);
    res.on("close", close);
    send({ type: "ready" });
  }
}
