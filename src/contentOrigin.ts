import type express from "express";
import { CONTENT_HOST, baseUrl, pageHost, pageIdFromHost } from "./config.js";

/** A tab page's origin (t-ab12cd34.localhost) or the shared content origin (127.0.0.2): never the board's. */
export function isContentHost(req: express.Request): boolean {
  return req.hostname === CONTENT_HOST || framePageId(req) !== undefined;
}

/** The tab whose own origin the request came in on (#660), or undefined. */
export function framePageId(req: express.Request): string | undefined {
  return pageIdFromHost(req.hostname);
}

const STATE_PATH = /^\/api\/tabs\/[^/]+\/state$/;
const EVENTS_PATH = /^\/api\/tabs\/[^/]+\/events$/;
const LOCAL_PATH = /^\/api\/tabs\/[^/]+\/local$/;
const ACTION_PATH = /^\/api\/tabs\/[^/]+\/action$/;
const TEMPLATE_INCOMPATIBLE_PATH = /^\/api\/tabs\/[^/]+\/template-incompatible$/;
const ASSETS_PATH = /^\/api\/tabs\/[^/]+\/assets$/;
const ASSET_PATH = /^\/api\/tabs\/[^/]+\/assets\/[^/]+$/;
const BLOB_PATH = /^\/blob\/[^/]+$/;
const VIEW_PATH = /^\/view\/([^/]+)(\/asset\/[^/]+)?$/;
const VENDOR_PATH = /^\/vendor\/(highlight|marked|purify|editor)\.js$/;
/** The parts of pdfjs-dist a PDF file page loads, under /vendor/pdfjs. */
export const PDFJS_PATH = /^\/(build\/pdf(\.worker)?\.min\.mjs|(cmaps|standard_fonts|wasm)\/[\w.-]+)$/;

/** Data-free files every page may load: the injected tooltip script and the file viewer's libraries. */
function sharedFile(req: express.Request): boolean {
  if (req.method !== "GET") return false;
  if (req.path === "/tooltip.js" || VENDOR_PATH.test(req.path)) return true;
  return req.path.startsWith("/vendor/pdfjs/") && PDFJS_PATH.test(req.path.slice("/vendor/pdfjs".length));
}

/** The page routes a page's own script calls (src/bridge.ts), each for its own tab id. */
function pageApi(req: express.Request): boolean {
  const { method, path } = req;
  if ((method === "GET" || method === "PUT") && (STATE_PATH.test(path) || LOCAL_PATH.test(path))) return true;
  if (method === "POST" && (EVENTS_PATH.test(path) || ACTION_PATH.test(path) || TEMPLATE_INCOMPATIBLE_PATH.test(path))) return true;
  if ((method === "GET" || method === "POST") && ASSETS_PATH.test(path)) return true;
  return (method === "GET" || method === "DELETE") && ASSET_PATH.test(path);
}

/**
 * Whether a browser sent the request from another origin: another page's script, or a website.
 * Browsers mark every fetch with Sec-Fetch-Site and every write with Origin.
 */
function crossOrigin(req: express.Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin") return true;
  const origin = req.get("origin");
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.host !== req.get("host");
  } catch {
    return true;
  }
}

/** Where /view/:id lives: on that page's own origin, keeping the port and query it came with. */
function viewRedirect(req: express.Request, id: string): string {
  const port = /:(\d+)$/.exec(req.get("host") ?? "")?.[1];
  const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  return `http://${pageHost(id)}${port ? `:${port}` : ""}${req.path}${query}`;
}

export function contentOriginGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isContentHost(req)) {
    const page = framePageId(req);
    if (sharedFile(req) || (req.method === "GET" && BLOB_PATH.test(req.path))) {
      next();
      return;
    }
    const view = req.method === "GET" ? VIEW_PATH.exec(req.path) : null;
    if (view) {
      let id: string;
      try {
        id = decodeURIComponent(view[1]);
      } catch {
        res.status(404).type("text").send("Tab not found.");
        return;
      }
      // A page is only served on its own origin, so another page's script cannot load it into its own.
      if (page === id) next();
      else res.redirect(302, viewRedirect(req, id));
      return;
    }
    // Page routes answer only on a page's own origin, and only to that page's own script. Which
    // tab ids that page may name is checked with the page access rules (app.param("id")).
    if (page !== undefined && pageApi(req)) {
      if (crossOrigin(req)) {
        res.status(403).json({ error: "A page's routes answer only to its own script" });
        return;
      }
      next();
      return;
    }
    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
      res.redirect(302, `${baseUrl()}/`);
      return;
    }
    res.status(403).json({ error: "This origin only serves tab pages" });
    return;
  }
  if (!BOARD_HOSTS.has(req.hostname)) {
    // Another name for loopback is a rebound DNS name: a website reaching for the board.
    res.status(403).type("text").send("Unknown host.");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && crossOrigin(req)) {
    // Page scripts and websites cannot write through the board's API; only the board UI and local tools can.
    res.status(403).json({ error: "The board's API does not answer other origins" });
    return;
  }
  if (req.path === "/view" || req.path.startsWith("/view/") || req.path.startsWith("/blob/")) {
    res.status(404).type("text").send("Tab pages are served from the content origin.");
    return;
  }
  next();
}

const BOARD_HOSTS = new Set(["127.0.0.1", "localhost"]);
