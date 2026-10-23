import { z } from "zod";

export const pluginId = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const file = z.string().min(1).max(240).refine(v => !v.includes("\\") && !v.startsWith("/") && !v.split("/").some(p => !p || p === "." || p === "..") && !v.includes(":"), "Use a relative package path");
const componentName = z.string().regex(/^[a-zA-Z][\w-]{0,63}$/);
// Fail closed: conversion libraries may preserve unknown validation keywords only as metadata.
const schemaKeywords = new Set(["$schema", "title", "description", "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "anyOf", "allOf", "oneOf"]);
function checkPropsSchema(schema: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Props schema is too deep");
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Expected a JSON Schema object");
  for (const [key, value] of Object.entries(schema)) {
    if (!schemaKeywords.has(key)) throw new Error(`Unsupported props schema keyword: ${key}`);
    if (key === "properties") for (const child of Object.values(value as object)) checkPropsSchema(child, depth + 1);
    if (["items", "additionalProperties"].includes(key)) checkPropsSchema(value, depth + 1);
    if (["anyOf", "allOf", "oneOf"].includes(key)) {
      if (!Array.isArray(value)) throw new Error(`Expected an array for ${key}`);
      value.forEach(child => checkPropsSchema(child, depth + 1));
    }
  }
}
const propsSchema = z.record(z.string(), z.unknown()).superRefine((schema, ctx) => {
  try { if (schema.type !== "object") throw new Error("Props must have type object"); checkPropsSchema(schema); z.fromJSONSchema(schema); } catch (error) { ctx.addIssue({ code: "custom", message: `Invalid component props schema: ${String(error)}` }); }
});
export const pluginComponentSchema = z.object({
  description: z.string().min(1).max(1000), html: file, props: propsSchema,
  height: z.object({ min: z.number().int().min(64).max(1200), max: z.number().int().min(64).max(1200) }).refine(v => v.min <= v.max).default({ min: 64, max: 480 }),
  methods: z.array(componentName).max(100).default([]),
  state: z.array(z.string().min(1).max(200).regex(/^[^*]+(?:\/\*)?$/)).max(100).default([]),
  events: z.array(z.string().regex(/^[a-zA-Z][\w.-]{0,99}$/)).max(100).default([]),
}).strict();
export const manifestSchema = z.object({
  id: pluginId,
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  summary: z.string().min(1).max(200),
  author: z.string().max(200).optional(),
  risky: z.boolean().default(true),
  backend: file.optional(),
  source: file.optional(),
  guide: file.optional(),
  readme: file.optional(),
  components: z.record(componentName, pluginComponentSchema).default({}),
  access: z.object({ files: z.array(z.string().max(1000)).max(50).default([]), network: z.array(z.string().max(250)).max(50).default([]) }).default({ files: [], network: [] }),
  methods: z.record(z.string().regex(/^[a-zA-Z][\w-]{0,63}$/), z.object({
    description: z.string().max(1000),
    agent: z.enum(["read", "board", "ask"]).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  })).default({}),
  settings: z.record(z.string().regex(/^[a-zA-Z][\w-]{0,63}$/), z.object({
    label: z.string().min(1).max(120),
    type: z.enum(["string", "number", "boolean", "secret", "paths"]),
    description: z.string().max(1000).optional(),
    default: z.unknown().optional(),
  })).default({}),
  templates: z.array(z.object({ key: pluginId, metadata: file, html: file, guide: file.optional(), actions: z.record(z.string(), z.object({ description: z.string(), args: z.string() })).optional(), hooks: z.array(z.enum(["seed", "reply", "replyDelivered", "sweep", "drive", "launched", "launchAllowed", "runHold", "runEvent"])).optional() })).max(50).default([]),
}).strict();
export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginMethod = PluginManifest["methods"][string];
export function componentStateAllowed(patterns: string[], key: string): boolean {
  return patterns.some(pattern => pattern.endsWith("/*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern);
}
export function validateComponentProps(schema: Record<string, unknown>, props: unknown): void {
  // Zod's object conversion only enforces required names present in properties.
  // JSON Schema also permits required names absent from properties.
  const requiredFit = (s: any, value: any): boolean => {
    if (typeof s === "boolean") return s;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (s.required?.some((key: string) => !Object.hasOwn(value, key))) return false;
      for (const [key, child] of Object.entries(s.properties ?? {})) if (Object.hasOwn(value, key) && !requiredFit(child, value[key])) return false;
      if (s.additionalProperties && typeof s.additionalProperties === "object") for (const key of Object.keys(value)) if (!Object.hasOwn(s.properties ?? {}, key) && !requiredFit(s.additionalProperties, value[key])) return false;
    }
    if (Array.isArray(value) && s.items && !value.every(v => requiredFit(s.items, v))) return false;
    const fits = (child: any) => z.fromJSONSchema(child).safeParse(value).success && requiredFit(child, value);
    if (s.allOf && !s.allOf.every(fits)) return false;
    if (s.anyOf && !s.anyOf.some(fits)) return false;
    if (s.oneOf && s.oneOf.filter(fits).length !== 1) return false;
    return true;
  };
  if (!requiredFit(schema, props)) throw new Error("Invalid component props: required properties or schema alternatives do not match.");
  const result = z.fromJSONSchema(schema).safeParse(props);
  if (!result.success) throw new Error(`Invalid component props: ${result.error.message}`);
}

export function parseManifest(value: unknown): PluginManifest { return manifestSchema.parse(value); }

/** Declaration is metadata only; it can never grant access. */
export function declaredPlugins(html: string): string[] {
  const ids = new Set<string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
    if (attrs.get("name")?.toLowerCase() !== "scribe-plugins") continue;
    for (const id of (attrs.get("content") ?? "").split(/[\s,]+/)) if (pluginId.safeParse(id).success) ids.add(id);
  }
  return [...ids];
}

export function declarePlugins(html: string, ids: unknown): string {
  if(ids===undefined)return html;
  const plugins=z.array(pluginId).max(50).parse(ids);
  const clean=html.replace(/<meta\b(?=[^>]*\bname\s*=\s*["']scribe-plugins["'])[^>]*>/gi,"");
  if(!plugins.length)return clean;
  const meta=`<meta name="scribe-plugins" content="${[...new Set(plugins)].join(" ")}">`;
  if(/<head\b[^>]*>/i.test(clean))return clean.replace(/<head\b[^>]*>/i,head=>`${head}\n${meta}`);
  if(/<!doctype[^>]*>/i.test(clean))return clean.replace(/<!doctype[^>]*>/i,doctype=>`${doctype}\n${meta}`);
  return `${meta}\n${clean}`;
}
