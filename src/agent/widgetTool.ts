import type { Item } from "./types.js";
import { isIP } from "node:net";
import { safeEmbedUrl } from "../embed.js";

export const MAX_WIDGET_HTML = 256 * 1024;
export const MAX_WIDGET_STATE = 64 * 1024;
export type WidgetInput = { html?: string; plugin?: string; component?: string; props?: unknown; title?: string; fallback?: string; wait?: boolean };
export type WidgetAnswer = { answered: true; data: unknown; summary: string } | { skipped: true };
export type WidgetItem = Extract<Item, { kind: "component" }>;

export function widgetString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name} must be text of at most ${max} UTF-8 bytes.`);
  return value;
}

export function widgetJson(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") > MAX_WIDGET_STATE) throw new Error("Widget data must be at most 64 KiB.");
  return JSON.parse(json);
}

export function parseWidgetInput(value: unknown): WidgetInput {
  if (!value || typeof value !== "object") throw new Error("Provide html for the widget.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["html", "plugin", "widget", "component", "props", "title", "fallback", "wait"].includes(key))) throw new Error("Unknown widget input.");
  // Agents name a plugin widget with `widget`; page tags and stored chat items still pass `component`.
  const name = input.widget ?? input.component;
  let source: WidgetInput;
  if (input.plugin !== undefined || name !== undefined || input.props !== undefined) {
    if (input.html !== undefined) throw new Error("Provide either html or plugin/widget/props.");
    const plugin = widgetString(input.plugin, "plugin", 64), component = widgetString(name, "widget", 64);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(plugin) || !/^[a-zA-Z][\w-]{0,63}$/.test(component)) throw new Error("Invalid plugin or widget name.");
    source = { plugin, component, props: widgetJson(input.props ?? {}) };
  } else {
    const html = widgetString(input.html, "html", MAX_WIDGET_HTML);
    if (!html.trim()) throw new Error("html must not be empty.");
    source = { html };
  }
  if (input.wait !== undefined && typeof input.wait !== "boolean") throw new Error("wait must be true or false.");
  return { ...source, ...(input.title !== undefined ? { title: widgetString(input.title, "title", 300) } : {}), ...(input.fallback !== undefined ? { fallback: widgetString(input.fallback, "fallback", 8000) } : {}), wait: input.wait === true };
}

export function widgetText(item: WidgetItem): string {
  return item.summary ?? item.fallback ?? item.title ?? "Interactive widget";
}

/** Only page/card keys and external websites. Widgets cannot promote files into page access. */
export function widgetLink(value: unknown): string {
  const link = widgetString(value, "link", 8000);
  if (/^scribe:[a-zA-Z0-9_-]+(?:#[^\s]*)?$/.test(link)) return link;
  const safe = safeEmbedUrl(link);
  if (safe) {
    const url = new URL(safe);
    const name = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!isIP(name) && name !== "localhost" && !name.endsWith(".localhost")) return safe;
  }
  throw new Error("Widgets can open Scribe page/card keys or external http(s) websites.");
}
