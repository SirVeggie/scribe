import type express from "express";
import { CONTENT_HOST, baseUrl } from "./config.js";

export function isContentHost(req: express.Request): boolean {
  return req.hostname === CONTENT_HOST;
}

const STATE_PATH = /^\/api\/tabs\/[^/]+\/state$/;
const EVENTS_PATH = /^\/api\/tabs\/[^/]+\/events$/;
const LOCAL_PATH = /^\/api\/tabs\/[^/]+\/local$/;
const ACTION_PATH = /^\/api\/tabs\/[^/]+\/action$/;
const TEMPLATE_INCOMPATIBLE_PATH = /^\/api\/tabs\/[^/]+\/template-incompatible$/;
const ASSETS_PATH = /^\/api\/tabs\/[^/]+\/assets$/;
const ASSET_PATH = /^\/api\/tabs\/[^/]+\/assets\/[^/]+$/;
const BLOB_PATH = /^\/blob\/[^/]+$/;
const VENDOR_PATH = /^\/vendor\/(highlight|marked|purify|editor)\.js$/;
/** The parts of pdfjs-dist a PDF file page loads, under /vendor/pdfjs. */
export const PDFJS_PATH = /^\/(build\/pdf(\.worker)?\.min\.mjs|(cmaps|standard_fonts|wasm)\/[\w.-]+)$/;

export function contentOriginGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isContentHost(req)) {
    // The page runtime injects this shared, data-free tooltip script.
    if (req.method === "GET" && req.path === "/tooltip.js") {
      next();
      return;
    }
    // Shared, data-free libraries; the file viewer (file pages) highlights and renders with them.
    if (req.method === "GET" && (VENDOR_PATH.test(req.path) || (req.path.startsWith("/vendor/pdfjs/") && PDFJS_PATH.test(req.path.slice("/vendor/pdfjs".length))))) {
      next();
      return;
    }
    if (req.method === "GET" && /^\/view\/[^/]+$/.test(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && /^\/view\/[^/]+\/asset\/[^/]+$/.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "PUT") && STATE_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "POST" && (EVENTS_PATH.test(req.path) || ACTION_PATH.test(req.path))) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "PUT") && LOCAL_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "POST" && TEMPLATE_INCOMPATIBLE_PATH.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && ASSETS_PATH.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "DELETE") && ASSET_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && BLOB_PATH.test(req.path)) {
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
  if (req.path === "/view" || req.path.startsWith("/view/") || req.path.startsWith("/blob/")) {
    res.status(404).type("text").send("Tab pages are served from the content origin.");
    return;
  }
  next();
}

