import { limitComponentAction, relayComponentEvents, type ComponentRate } from "./plugins/componentHost.js";
import { randomBytes } from "node:crypto";
import type express from "express";
import type { BoardStore } from "./store.js";
import type { PluginService } from "./plugins/service.js";
import { componentStateAllowed } from "./plugins/manifest.js";
import { checkPermission } from "./pagePermissions.js";
import { componentJson, componentLink, parseComponentInput } from "./agent/componentTool.js";
import { pageComponentHost, PORT } from "./config.js";

export const PAGE_COMPONENT_LIMIT = 64;
export const GLOBAL_COMPONENT_LIMIT = 500;
export const COMPONENT_LEASE_MS = 90_000;
type Mount = ComponentRate & { id: string; page: string; revision: number; plugin: string; component: string; props: unknown; local: Record<string, unknown>; hash: string; token: string; diagnostics: boolean; capture: boolean; expires: number };

/** Ephemeral page mounts. Identity, revision and declarations are checked again on every operation. */
export class PageComponents {
  private mounts = new Map<string, Mount>();
  constructor(private store: Pick<BoardStore, "get" | "pagePermissions">, private plugins: PluginService, private now = Date.now) {}

  release(page: string, id: string) { if (this.mounts.get(id)?.page === page) this.mounts.delete(id); }

  private prune() {
    for (const [id, mount] of this.mounts) {
      if (mount.expires <= this.now() || this.store.get(mount.page)?.revision !== mount.revision) this.mounts.delete(id);
    }
  }

  private inspect(page: string, input: Record<string, unknown>) {
    const tab = this.store.get(page);
    if (!tab) throw new Error("Page not found.");
    const spec = parseComponentInput({ plugin: input.plugin, component: input.component, props: input.props });
    const current = this.plugins.component(spec.plugin!, spec.component!, spec.props);
    if (checkPermission(this.store.pagePermissions(page), { perm: `plugin.${spec.plugin}` }) === "deny") throw new Error("This page denies the plugin.");
    return { tab, spec, current };
  }

  validate(page: string, input: Record<string, unknown>) {
    return { height: this.inspect(page, input).current.definition.height };
  }

  resolve(page: string, input: Record<string, unknown>) {
    const { tab, spec, current } = this.inspect(page, input);
    const id = `pc_${randomBytes(8).toString("hex")}`;
    const local = componentJson(input.local ?? {});
    if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("Component local state must be an object.");
    this.prune();
    const capture = input.capture === true;
    if ([...this.mounts.values()].filter(mount => mount.page === page && mount.capture === capture).length >= PAGE_COMPONENT_LIMIT) throw new Error(`Page component limit reached (${PAGE_COMPONENT_LIMIT} active instances across this page's ${capture ? "captures" : "viewers"}). Scroll other components out of view or close another viewer, then reload.`);
    if (this.mounts.size >= GLOBAL_COMPONENT_LIMIT) throw new Error(`Component limit reached (${GLOBAL_COMPONENT_LIMIT} active page instances). Close another page viewer.`);
    const mount: Mount = { id, page, revision: tab.revision, plugin: spec.plugin!, component: spec.component!, props: spec.props, local: local as Record<string, unknown>, hash: current.hash, token: randomBytes(16).toString("hex"), diagnostics: input.diagnostics === true, capture: input.capture === true, expires: this.now() + COMPONENT_LEASE_MS, at: Date.now(), count: 0, active: 0 };
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
    return { ...current, mount };
  }

  renew(page: string, id: string) {
    // Polling an SSE stream must not keep an abandoned browser mount alive.
    this.current(page, id, false).mount.expires = this.now() + COMPONENT_LEASE_MS;
    return { ok: true };
  }

  renewAll(page: string, ids: unknown) {
    if (!Array.isArray(ids) || ids.length > PAGE_COMPONENT_LIMIT || ids.some(id => typeof id !== "string")) throw new Error("Invalid component leases.");
    const errors: Record<string, string> = {};
    for (const id of ids) {
      try { this.renew(page, id); } catch (error) { errors[id] = (error as Error).message; }
    }
    return { ok: true, errors };
  }

  async action(page: string, id: string, input: Record<string, unknown>) {
    const { definition, mount } = this.current(page, id);
    mount.expires = this.now() + COMPONENT_LEASE_MS;
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
