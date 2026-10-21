import { z } from "zod";

export const pluginId = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const file = z.string().min(1).max(240).refine(v => !v.includes("\\") && !v.startsWith("/") && !v.split("/").some(p => !p || p === "." || p === "..") && !v.includes(":"), "Use a relative package path");
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
