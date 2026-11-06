import express from "express";
import { identify } from "./callers.js";
import type { Tab } from "./types.js";
import { isContentHost } from "./contentOrigin.js";
import { VaultTokenError, agentValueProblem, vault, vaultUnavailable, type FragmentMeta } from "./vault.js";

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
  /** vault_show: the fragment as a card in that chat thread's running turn. Throws when it can't. */
  show(thread: string, fragment: FragmentMeta, note?: string): void;
};

/**
 * POST /api/vault/protect { value, hint?, kind? }: add a fragment (agents and the user).
 * GET /api/vault: the fragments' metadata, never values, with how many pages hold each.
 * DELETE /api/vault/:id: the user only.
 * POST /api/vault/show { id? | query?, note? }: a chat's agent puts a value in its chat for the user (#1049).
 * GET /api/vault/:id/value: the value, for the board UI only (the chat's reveal).
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
  router.post("/show", (req, res) => {
    const caller = identify(req);
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    if (!caller.thread || caller.device) {
      res.status(403).json({ error: "vault_show only works in this Scribe's own chat threads." });
      return;
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const query = typeof body.query === "string" ? body.query : "";
    const matches = id ? [vault().meta(id.replace(/^⟦p:/, "").split(/[\s⟧]/)[0])].filter((meta): meta is FragmentMeta => Boolean(meta)) : vault().find(query);
    if (!matches.length) {
      res.status(404).json({ error: id ? `No protected value has the id ${id}.` : `No protected value's hint matches "${query}". vault_list shows them all.` });
      return;
    }
    // Several hints fit: the agent picks one by id rather than the user seeing the wrong value.
    if (matches.length > 1 && !id && matches[0].hint.toLowerCase() !== query.trim().toLowerCase()) {
      res.status(409).json({ error: "Several protected values match; call vault_show again with one id.", matches: matches.slice(0, 10).map(({ id, hint, kind }) => ({ id, hint, kind })) });
      return;
    }
    const fragment = matches[0];
    try {
      host.show(caller.thread, fragment, typeof body.note === "string" ? body.note.slice(0, 200) : undefined);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json({ shown: true, id: fragment.id, hint: fragment.hint });
  });
  router.get("/:id/value", (req, res) => {
    // The board UI only: not agents, and not page scripts, which run as the user on their own origin.
    const caller = identify(req);
    if (caller.viewer === "agent" || isContentHost(req) || caller.device) {
      res.status(403).json({ error: "Only the user's own Scribe window can reveal a protected value." });
      return;
    }
    const value = vault().reveal(req.params.id);
    if (value === undefined) {
      res.status(404).json({ error: "This protected value was removed." });
      return;
    }
    res.set("Cache-Control", "no-store").json({ value });
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
