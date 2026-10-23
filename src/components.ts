import type express from "express";
import fs from "node:fs";
import path from "node:path";
import { componentItemFromHost, pageComponentFromHost, shellOrigins, pageOrigin } from "./config.js";
import type { PageComponents } from "./pageComponents.js";
import type { AgentHost } from "./agent/host.js";
import type { ComponentItem } from "./agent/componentTool.js";
import { plugins } from "./plugins/current.js";
import { PAGE_PROBLEM_JS, KIT_TONES } from "./pageProblems.js";

export function componentCsp(page?: string): string {
  const ancestors = page ? [...shellOrigins(), pageOrigin(page)] : shellOrigins();
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts; frame-ancestors ${ancestors.join(" ")}`;
}
export const COMPONENT_CSP = componentCsp();
const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function componentDocument(item: Pick<ComponentItem, "html" | "local" | "props" | "plugin">, kit: { css: string; js: string; bridge: string }, diagnostics?: { token: string; capture?: boolean; relay?: boolean }): string {
  // Install the small bridge before any agent script or kit code runs. No page bridge or API tokens.
  const reports = diagnostics ? `<script>window.__SCRIBE_PROBLEMS__={...${jsonScript({ ...diagnostics, tones: KIT_TONES, insertLine: 0, insertedLines: 0 })},report:function(data){${diagnostics.capture && !diagnostics.relay ? "window.__componentReport=data" : "window.__scribeComponentReport(data)"}}};${PAGE_PROBLEM_JS}</script>` : "";
  const boot = `${reports}<script>${kit.bridge};componentBridge(${jsonScript(item.local ?? {})},${jsonScript(item.props ?? {})},${Boolean(item.plugin)});</script>`;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:dark;--bg:#1a1a1d;--text:#e8e8ea;--muted:#8e8e96;--border:#ffffff18;--accent:#c9c9d0;--code-bg:#131315}*{box-sizing:border-box}html,body{margin:0}body{padding:12px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}</style><style>${kit.css}</style>${boot}`;
  // Full documents and fragments both get the same trusted prefix, before agent-written HTML.
  return `<!doctype html><html style="visibility:hidden"><head>${head}</head><body>${item.html ?? ""}<script>${kit.js}</script></body></html>`;
}

export function componentSite(host: () => AgentHost | undefined, publicDir: string, pages?: PageComponents): express.RequestHandler {
  let kit: { css: string; js: string; bridge: string } | undefined;
  return (req, res, next) => {
    const id = componentItemFromHost(req.hostname) ?? pageComponentFromHost(req.hostname);
    if (!id) { next(); return; }
    try {
      kit ??= { bridge: fs.readFileSync(path.join(publicDir, "component-bridge.js"), "utf8"), css: fs.readFileSync(path.join(publicDir, "kit.css"), "utf8"), js: fs.readFileSync(path.join(publicDir, "kit.js"), "utf8") };
      if (typeof req.query.page === "string" && pages) {
        const { mount, html } = pages.current(req.query.page, id, false);
        const csp = componentCsp(mount.page);
        res.set({ "Content-Security-Policy": csp, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }).type("html").send(componentDocument({ html, plugin: mount.plugin, props: mount.props, local: mount.local }, kit, mount.diagnostics ? { token: mount.token, capture: mount.capture, relay: true } : undefined));
        return;
      }
      const thread = typeof req.query.thread === "string" ? req.query.thread : "";
      const item = host()?.componentItem(thread, id);
      if (!item) throw new Error("Component not found.");
      let renderItem = item;
      if (item.plugin) {
        host()!.componentPlugin(thread, id);
        const current = plugins!.component(item.plugin, item.component!, item.props);
        renderItem = { ...item, html: current.html };
      }
      res.set({ "Content-Security-Policy": COMPONENT_CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }).type("html").send(componentDocument(renderItem, kit, host()!.componentProblems.boot(id, 0)));
    } catch { res.status(404).type("text").send("Component not found."); }
  };
}
