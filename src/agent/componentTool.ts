import type { Item } from "./types.js";
import { isIP } from "node:net";
import { safeEmbedUrl } from "../embed.js";

export const MAX_COMPONENT_HTML = 256 * 1024;
export const MAX_COMPONENT_STATE = 64 * 1024;
export type ComponentInput = { html?: string; plugin?: string; component?: string; props?: unknown; title?: string; fallback?: string; wait?: boolean };
export type ComponentAnswer = { answered: true; data: unknown; summary: string } | { skipped: true };
export type ComponentItem = Extract<Item, { kind: "component" }>;

export function componentString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) throw new Error(`${name} must be text of at most ${max} UTF-8 bytes.`);
  return value;
}

export function componentJson(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") > MAX_COMPONENT_STATE) throw new Error("Component data must be at most 64 KiB.");
  return JSON.parse(json);
}

export function parseComponentInput(value: unknown): ComponentInput {
  if (!value || typeof value !== "object") throw new Error("Provide html for the component.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["html", "plugin", "component", "props", "title", "fallback", "wait"].includes(key))) throw new Error("Unknown component input.");
  let source: ComponentInput;
  if (input.plugin !== undefined || input.component !== undefined || input.props !== undefined) {
    if (input.html !== undefined) throw new Error("Provide either html or plugin/component/props.");
    const plugin = componentString(input.plugin, "plugin", 64), component = componentString(input.component, "component", 64);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(plugin) || !/^[a-zA-Z][\w-]{0,63}$/.test(component)) throw new Error("Invalid plugin or component name.");
    source = { plugin, component, props: componentJson(input.props ?? {}) };
  } else {
    const html = componentString(input.html, "html", MAX_COMPONENT_HTML);
    if (!html.trim()) throw new Error("html must not be empty.");
    source = { html };
  }
  if (input.wait !== undefined && typeof input.wait !== "boolean") throw new Error("wait must be true or false.");
  return { ...source, ...(input.title !== undefined ? { title: componentString(input.title, "title", 300) } : {}), ...(input.fallback !== undefined ? { fallback: componentString(input.fallback, "fallback", 8000) } : {}), wait: input.wait === true };
}

export function componentText(item: ComponentItem): string {
  return item.summary ?? item.fallback ?? item.title ?? "Interactive component";
}

/** Only page/card keys and external websites. Components cannot promote files into page access. */
export function componentLink(value: unknown): string {
  const link = componentString(value, "link", 8000);
  if (/^scribe:[a-zA-Z0-9_-]+(?:#[^\s]*)?$/.test(link)) return link;
  const safe = safeEmbedUrl(link);
  if (safe) {
    const url = new URL(safe);
    const name = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!isIP(name) && name !== "localhost" && !name.endsWith(".localhost")) return safe;
  }
  throw new Error("Components can open Scribe page/card keys or external http(s) websites.");
}
