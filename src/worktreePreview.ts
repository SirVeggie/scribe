import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { ThreadWorktree } from "./agent/types.js";
import { previewThreadFromHost } from "./config.js";
import { previewShared } from "./contentOrigin.js";

export function isLoopback(address: string | undefined): boolean {
  return !!address && (address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address));
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * A worktree's public/ at the root of its chat's own origin (#703), so its scripts never run as the
 * board. Only Scribe's recorded, open worktrees; never a caller-supplied filesystem path. Requests on
 * other hosts, and the shared files the daemon serves (previewShared), go on.
 */
export function worktreePreviewSite(lookup: (threadId: string) => ThreadWorktree | null | undefined): express.RequestHandler {
  return (req, res, next) => {
    const threadId = previewThreadFromHost(req.hostname);
    if (threadId === undefined) { next(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!isLoopback(req.socket.remoteAddress)) { res.sendStatus(403); return; }
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.sendStatus(405); return; }
    if (previewShared(req)) { next(); return; }
    void (async () => {
      const wt = lookup(threadId);
      if (!wt || wt.closed) { res.status(404).send("No open worktree for this thread."); return; }
      const name = req.path === "/" ? "index.html" : decodeURIComponent(req.path.slice(1));
      // Reject hidden files, traversal, Windows separators, drives and alternate data streams.
      if (/[\\:\0]/.test(name) || name.split("/").some(part => !part || part.startsWith("."))) {
        res.sendStatus(404); return;
      }
      const worktree = await fs.realpath(wt.path);
      const root = await fs.realpath(path.join(wt.path, "public"));
      const lexical = path.resolve(root, name);
      if (!inside(worktree, root) || !inside(root, lexical)) { res.sendStatus(404); return; }
      const file = await fs.realpath(lexical);
      if (!inside(root, file) || !(await fs.stat(file)).isFile()) { res.sendStatus(404); return; }
      res.sendFile(file, { cacheControl: false, lastModified: false, headers: { "Cache-Control": "no-store" } }, err => {
        if (err && !res.headersSent) res.sendStatus(404);
      });
    })().catch(() => { if (!res.headersSent) res.status(404).send("Worktree preview file not found."); });
  };
}
