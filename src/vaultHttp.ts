import express from "express";
import { identify } from "./callers.js";
import type { Tab } from "./types.js";
import { VaultTokenError, agentValueProblem, vault, vaultUnavailable } from "./vault.js";

/**
 * Protected data over HTTP (#1045). Everything the daemon answers an agent goes through the vault's
 * redaction here, in the daemon, so values never reach a process an agent controls (its MCP child
 * included). What an agent writes has its tokens swapped back before any route sees it.
 */
export function redactAgentResponses(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (identify(req).viewer !== "agent") {
    next();
    return;
  }
  // Values that can't be read can't be redacted either: agents wait until the user fixes it.
  const locked = vaultUnavailable();
  if (locked) {
    res.status(503).json({ error: `Scribe's protected data is locked (${locked}), so agents can't read pages until the user fixes it.` });
    return;
  }
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  let redacted = false;
  res.json = (body?: unknown) => {
    redacted = true;
    return json(vault().redactDeep(body));
  };
  res.send = (body?: unknown) => {
    // res.json sends its own text through here; that one is redacted already.
    if (!redacted && typeof body === "string") return send(vault().redact(body));
    return send(body);
  };
  next();
}

/** Goes after a body parser: an agent's ⟦p:…⟧ tokens become their values again, and an unknown or edited one is refused. */
export function restoreAgentBodies(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.body === undefined || identify(req).viewer !== "agent") {
    next();
    return;
  }
  try {
    req.body = vault().restoreDeep(req.body);
  } catch (err) {
    if (err instanceof VaultTokenError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  next();
}

/** An agent may not protect a value that shows up on more pages than this: ask the user instead. */
const AGENT_MAX_PAGES = 25;

export type VaultRoutesHost = {
  /** The pages this caller may see, for counts. */
  pages(req: express.Request): Tab[];
  /** Who an agent caller is, for createdBy. */
  agentName(req: express.Request): string;
};

/**
 * POST /api/vault/protect { value, hint?, kind? }: add a fragment (agents and the user).
 * GET /api/vault: the fragments' metadata, never values, with how many pages hold each.
 * DELETE /api/vault/:id: the user only.
 */
export function vaultRouter(host: VaultRoutesHost): express.Router {
  const router = express.Router();
  router.post("/protect", async (req, res) => {
    const caller = identify(req);
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const value = typeof body.value === "string" ? body.value : "";
    const agent = caller.viewer === "agent";
    if (agent) {
      const problem = agentValueProblem(value);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const pages = host.pages(req).filter((tab) => pageHas(tab, value)).length;
      if (pages > AGENT_MAX_PAGES) {
        res.status(400).json({ error: `That value is on ${pages} pages, too common for an agent to protect. Ask the user to add it if it really is sensitive.` });
        return;
      }
    }
    try {
      const { fragment, existed } = await vault().add({
        value,
        hint: body.hint as string | undefined,
        kind: body.kind as string | undefined,
        source: agent ? "agent" : "user",
        createdBy: agent ? host.agentName(req) : "user",
        ...(caller.thread ? { createdThread: caller.thread } : {}),
      });
      res.json({ fragment, existed, token: `⟦p:${fragment.id} ${fragment.hint}⟧` });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  router.get("/", (req, res) => {
    const pages = host.pages(req);
    const counts = vault().count(pages.map(pageStrings));
    res.json({ fragments: vault().list().map((fragment) => ({ ...fragment, pages: counts.get(fragment.id) ?? 0 })) });
  });
  router.delete("/:id", (req, res) => {
    if (identify(req).viewer === "agent") {
      res.status(403).json({ error: "Only the user can remove protected values" });
      return;
    }
    if (!vault().remove(req.params.id)) {
      res.status(404).json({ error: "No such protected value" });
      return;
    }
    res.json({ ok: true });
  });
  return router;
}

function pageHas(tab: Tab, value: string): boolean {
  return pageStrings(tab).includes(value);
}

/** A page's title, HTML and every string in its state, one text to scan. */
function pageStrings(tab: Tab): string {
  const out = [tab.title, tab.html];
  const walk = (item: unknown): void => {
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      out.push(key);
      walk(child);
    }
  };
  walk(tab.state);
  return out.join("\n");
}
