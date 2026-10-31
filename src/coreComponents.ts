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

export const COMPONENT_PATH = /^\/c\/([a-z][a-z0-9-]{0,63})\.js$/;

const PUBLIC = new URL("../public/", import.meta.url);

export function coreComponent(name: string): CoreComponent | undefined {
  return CORE_COMPONENTS.find((component) => component.name === name);
}

export function readComponent(name: string): string | undefined {
  const component = coreComponent(name);
  return component && fs.readFileSync(new URL(component.file, PUBLIC), "utf8");
}

/** What plugin_guide returns for id "core". */
export function coreComponentGuide() {
  return {
    id: "core",
    summary: "Page components built into Scribe. Load one with <script src=\"/c/<name>.js\"></script>; no permission needed.",
    pageComponents: CORE_COMPONENTS.map(({ name, summary, guide }) => ({
      name,
      summary,
      src: `/c/${name}.js`,
      guide: fs.readFileSync(new URL(guide, PUBLIC), "utf8"),
    })),
  };
}

/** The scribe skill's table between its page-components markers; a test keeps the two the same. */
export function renderComponentDocs(): string {
  return ["| Load | Gives |", "|---|---|", ...CORE_COMPONENTS.map(({ name, summary }) => `| \`<script src="/c/${name}.js"></script>\` | ${summary} |`)].join("\n");
}

const COMPONENT_SCRIPT = /<script\b[^>]*\bsrc=["']\/c\/([a-z][a-z0-9-]{0,63})\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi;

/** Swap each page component's <script src> for an inline copy, so a downloaded page stands alone. Unknown names stay as they are. */
export function inlineComponents(html: string, read: (name: string) => string | undefined = readComponent): string {
  return html.replace(COMPONENT_SCRIPT, (tag, name: string) => {
    const code = read(name);
    // data-scribe-component tells the component it was loaded by a page (select.js checks it).
    return code === undefined ? tag : `<script data-scribe-component="${name}">${code.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
}
