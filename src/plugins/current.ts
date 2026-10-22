import type { PluginService } from "./service.js";
import type { PluginActions } from "./actions.js";
export let plugins: PluginService | null = null;
export let pluginActions: PluginActions | null = null;
export function setPlugins(service: PluginService | null): void { plugins = service; }
export function setPluginActions(actions: PluginActions | null): void { pluginActions=actions; }
