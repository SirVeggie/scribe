import fs from "node:fs";

/**
 * Page components Scribe itself offers (#761): JS (with its own CSS) a page loads by name with
 * <script src="/c/<name>.js"></script>. Names and summaries are in the scribe skill; plugin_guide
 * with id "core" returns the guides. They stay backwards compatible, so URLs carry no version.
 */
export type CoreComponent = { name: string; summary: string; file: string; guide: string };

export const CORE_COMPONENTS: readonly CoreComponent[] = [
  { name: "select", summary: "Scribe's own dropdown in place of every native `<select>` on the page.", file: "select.js", guide: "select.md" },
  { name: "chart", summary: "`<s-chart>`: column, bar, line, area and sparkline charts in Scribe's theme, with hover, legend and a table view.", file: "chart.js", guide: "chart.md" },
];

/** /c/<name>.js for Scribe's own, /c/<plugin>/<name>.js for a plugin's (#930): match[1] is the plugin, match[2] the name. */
export const COMPONENT_PATH = /^\/c\/(?:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/)?([a-z][a-z0-9-]{0,63})\.js$/;

/** Reads a page component's code: Scribe's own without a plugin, else that plugin's (undefined when unknown or disabled). */
export type ComponentReader = (name: string, plugin?: string) => string | undefined;
/** A plugin's page component as plugin_guide lists it. */
export type PluginPageComponent = { plugin: string; name: string; summary: string; src: string };

const PUBLIC = new URL("../public/", import.meta.url);

export function coreComponent(name: string): CoreComponent | undefined {
  return CORE_COMPONENTS.find((component) => component.name === name);
}

export const readComponent: ComponentReader = (name, plugin) => {
  const component = plugin ? undefined : coreComponent(name);
  return component && fs.readFileSync(new URL(component.file, PUBLIC), "utf8");
};

/** What plugin_guide returns for id "core": Scribe's own page components, then the enabled plugins' (their guides come with plugin_guide for that plugin). */
export function coreComponentGuide(plugins: PluginPageComponent[] = []) {
  return {
    id: "core",
    summary: "Page components built into Scribe. Load one with <script src=\"/c/<name>.js\"></script>; no permission needed.",
    pageComponents: CORE_COMPONENTS.map(({ name, summary, guide }) => ({
      name,
      summary,
      src: `/c/${name}.js`,
      guide: fs.readFileSync(new URL(guide, PUBLIC), "utf8"),
    })),
    ...(plugins.length ? { pluginPageComponents: plugins } : {}),
  };
}

/** The scribe skill's table between its page-components markers; a test keeps the two the same. */
export function renderComponentDocs(): string {
  return ["| Load | Gives |", "|---|---|", ...CORE_COMPONENTS.map(({ name, summary }) => `| \`<script src="/c/${name}.js"></script>\` | ${summary} |`)].join("\n");
}

const COMPONENT_SCRIPT = /<script\b[^>]*\bsrc=["']\/c\/(?:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/)?([a-z][a-z0-9-]{0,63})\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi;

/** The plugins whose page components a page loads, so their calls count as declared (metadata only, like <scribe-widget>). */
export function componentPlugins(html: string): string[] {
  return [...new Set([...html.matchAll(COMPONENT_SCRIPT)].map((match) => match[1]).filter((plugin): plugin is string => !!plugin))];
}

/** Swap each page component's <script src> for an inline copy, so a downloaded page stands alone. Unknown names stay as they are. */
export function inlineComponents(html: string, read: ComponentReader = readComponent): string {
  return html.replace(COMPONENT_SCRIPT, (tag, plugin: string | undefined, name: string) => {
    const code = read(name, plugin);
    // data-scribe-component tells the component it was loaded by a page (select.js checks it).
    return code === undefined ? tag : `<script data-scribe-component="${plugin ? `${plugin}/${name}` : name}">${code.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
}
