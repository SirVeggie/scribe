import { limitComponentAction, relayComponentEvents, type ComponentRate } from "./plugins/componentHost.js";
import { randomBytes } from "node:crypto";
import type express from "express";
import type { BoardStore } from "./store.js";
import type { PluginService } from "./plugins/service.js";
import { componentStateAllowed } from "./plugins/manifest.js";
import { checkPermission } from "./pagePermissions.js";
import { componentJson, componentLink, parseComponentInput } from "./agent/componentTool.js";
import { pageComponentHost, PORT } from "./config.js";

type Mount = ComponentRate & { id: string; page: string; revision: number; plugin: string; component: string; props: unknown; local: Record<string, unknown>; hash: string; token: string; diagnostics: boolean; capture: boolean; touched: number };

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
    return limitComponentAction(mount, () => this.performAction(page, mount, definition, input));
  }

  private async performAction(page: string, mount: Mount, definition: ReturnType<PluginService["component"]>["definition"], input: Record<string, unknown>) {
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
    return this.plugins.call(mount.plugin, method, componentJson(input.args ?? {}), { kind: "page", page });
  }

  events(page: string, id: string, res: express.Response) {
    const initial = this.current(page, id);
    relayComponentEvents(res, {
      plugins: this.plugins, plugin: initial.mount.plugin, definition: initial.definition,
      valid: () => { try { this.current(page, id); return true; } catch { return false; } },
    });
  }
}
