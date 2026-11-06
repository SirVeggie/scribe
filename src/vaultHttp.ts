import express from "express";
import { identify } from "./callers.js";
import type { Tab } from "./types.js";
import { isContentHost } from "./contentOrigin.js";
import { MAX_INLINE_TEXT_BYTES, isTextFile } from "./agent/attachments.js";
import { VaultTokenError, agentValueProblem, vault, vaultUnavailable, type FragmentMeta } from "./vault.js";
import { MIN_MATCH, SUGGEST_OFF_MIN_MATCHES, SUGGEST_OFF_RATE, patternProblem, type DetectorDef, type DetectorView } from "./detectors.js";

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
/** How many of the pages holding a value the user's list names. */
const WHERE_MAX = 8;

export type VaultRoutesHost = {
  /** The pages this caller may see, for counts. */
  pages(req: express.Request): Tab[];
  /** Who an agent caller is, for createdBy. */
  agentName(req: express.Request): string;
  /** vault_show: the fragment as a card in that chat thread's running turn. Throws when it can't. */
  show(thread: string, fragment: FragmentMeta, note?: string): void;
  /** Every page, to look for a new or switched-on detector's matches at once. */
  allPages(): Tab[];
  /** Ask the user in the agent's chat to approve a detector change (#1047); waits for the answer. */
  approve(thread: string, ask: { title: string; detail: string; importance?: string }, signal: AbortSignal): Promise<{ allowed: boolean; message: string }>;
};

/**
 * POST /api/vault/protect { value, hint?, kind? }: add a fragment (agents and the user).
 * GET /api/vault: the fragments' metadata, never values, with how many pages hold each.
 * GET /api/vault/values: every fragment with its value, PATCH /api/vault/:id { value?, hint?, kind? } and
 * DELETE /api/vault/:id: the user only (#1046). Their views blur values and offer reveal and edit.
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
    const agent = identify(req).viewer === "agent";
    const where = new Map<string, { id: string; title: string }[]>();
    for (const tab of host.pages(req)) {
      for (const fragment of vault().within([pageStrings(tab)])) {
        const list = where.get(fragment.id) ?? [];
        list.push({ id: tab.id, title: tab.title });
        where.set(fragment.id, list);
      }
    }
    res.json({
      fragments: vault().list().map((fragment) => {
        const pages = where.get(fragment.id) ?? [];
        // The user's list names a few of the pages; an agent gets the count.
        return { ...fragment, pages: pages.length, ...(agent ? {} : { where: pages.slice(0, WHERE_MAX) }) };
      }),
      detectors: vault().detectors.list().map(detectorSummary),
    });
  });
  router.get("/values", (req, res) => {
    if (!ownWindow(req)) {
      res.status(403).json({ error: "Only the user's own Scribe window can read protected values." });
      return;
    }
    res.json({ fragments: vault().values() });
  });
  router.patch("/:id", async (req, res) => {
    if (!ownWindow(req)) {
      res.status(403).json({ error: "Only the user can edit protected values" });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
    try {
      const fragment = await vault().update(req.params.id, { value: text("value"), hint: text("hint"), kind: text("kind") });
      if (!fragment) {
        res.status(404).json({ error: "No such protected value" });
        return;
      }
      res.json({ fragment });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
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
  router.post("/check", (req, res) => {
    // The composer's check before it sends (#1048): which protected values and detected secrets a message holds.
    if (!ownWindow(req)) {
      res.status(403).json({ error: "Only the user's own Scribe window can check a message." });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const texts = [typeof body.text === "string" ? body.text : ""];
    for (const file of Array.isArray(body.files) ? body.files.slice(0, 20) : []) {
      const text = attachedText(file);
      if (text) texts.push(text);
    }
    const found = vault().hits(texts);
    res.json({ fragments: found.fragments.map(({ id, hint }) => ({ id, hint })), detected: found.detected });
  });
  router.get("/:id/value", (req, res) => {
    // The board UI only: not agents, and not page scripts, which run as the user on their own origin.
    if (!ownWindow(req)) {
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
  router.use("/detectors", detectorRouter(host));
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

/**
 * GET /api/tabs/:id/protected: the protected values in that page's own text, with their ids and hints,
 * so its view can blur them (#1046). A page learns nothing it doesn't hold already; agents get nothing.
 */
export function pageProtected(req: express.Request, res: express.Response, tab: Tab | undefined, ownFrame: boolean, extra: string[] = []): void {
  if (!tab || identify(req).viewer === "agent" || !ownFrame) {
    res.status(404).json({ error: "tab not found" });
    return;
  }
  res.json({ fragments: vault().within([pageStrings(tab), ...extra]).map(({ id, value, hint, kind }) => ({ id, value, hint, kind })) });
}

/** The board UI on this device: not agents, not page scripts (the user on their own origin), not another device. */
function ownWindow(req: express.Request): boolean {
  const caller = identify(req);
  return caller.viewer !== "agent" && !isContentHost(req) && !caller.device;
}

/** An attached file's text, when promptText would put it in the message (attachments.ts filesBlock). */
function attachedText(file: unknown): string {
  if (!file || typeof file !== "object") return "";
  const { name, mimeType, data } = file as Record<string, unknown>;
  if (typeof name !== "string" || typeof mimeType !== "string" || typeof data !== "string") return "";
  if (!isTextFile(name, mimeType) || Math.floor((data.length * 3) / 4) > MAX_INLINE_TEXT_BYTES) return "";
  return Buffer.from(data, "base64").toString("utf8");
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

/** Detectors as listed: definition, switch, counts and the estimated false-flag rate; the full history only in GET /detectors. */
function detectorSummary(view: DetectorView): Omit<DetectorView, "history"> & { lastChange?: DetectorView["history"][number] } {
  const { history, ...rest } = view;
  return { ...rest, ...(history.length ? { lastChange: history[history.length - 1] } : {}) };
}

/** Up to this many distinct matches in the user's pages a proposed detector may have: more is too broad to be a secret format. */
const PROPOSE_MAX_MATCHES = 200;
const SAMPLES = 6;

/** The value with its middle hidden, enough to tell what was matched without spelling a secret out. */
export function maskSample(value: string): string {
  const flat = value.replace(/\s+/g, " ");
  if (flat.length <= 10) return `${flat.slice(0, 2)}…`;
  return `${flat.slice(0, 6)}…${flat.slice(-3)} (${flat.length} chars)`;
}

/** What a pattern would match in these pages: distinct values, the pages they are on, a few samples. */
export function sampleMatches(
  pattern: string,
  flags: string | undefined,
  pages: Tab[],
  skip: (value: string) => boolean = () => false
): { values: number; pages: number; samples: { text: string; page: string }[] } {
  const re = new RegExp(pattern, `g${flags ?? ""}`);
  const seen = new Set<string>();
  const samples: { text: string; page: string }[] = [];
  let pageCount = 0;
  for (const tab of pages) {
    let hit = false;
    const text = pageStrings(tab);
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0]) {
        re.lastIndex += 1;
        continue;
      }
      if (m[0].length < MIN_MATCH || skip(m[0])) continue;
      hit = true;
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      if (samples.length < SAMPLES) samples.push({ text: maskSample(m[0]), page: tab.title || tab.key || tab.id });
      if (seen.size > PROPOSE_MAX_MATCHES) break;
    }
    if (hit) pageCount += 1;
    if (seen.size > PROPOSE_MAX_MATCHES) break;
  }
  return { values: seen.size, pages: pageCount, samples };
}

type Proposal = { action: "add" | "edit" | "enable" | "disable" | "remove"; id: string; def?: DetectorDef; reason?: string; importance?: string };

function readProposal(body: Record<string, unknown>): Proposal | string {
  const action = body.action;
  if (action !== "add" && action !== "edit" && action !== "enable" && action !== "disable" && action !== "remove") return "action must be add, edit, enable, disable or remove";
  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!id) return "id is required";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : undefined;
  const importance = typeof body.importance === "string" ? body.importance : undefined;
  const existing = vault().detectors.get(id);
  if (action === "add" || action === "edit") {
    if (action === "add" && existing) return `There is already a detector ${id}: use edit, or another id`;
    if (action === "edit" && !existing) return `No detector ${id}`;
    if (existing?.builtin) return `${id} is built in: it can only be enabled or disabled. Add a new detector instead.`;
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    const pattern = text("pattern") || existing?.pattern || "";
    const flags = text("flags") || existing?.flags || undefined;
    const problem = patternProblem(pattern, flags);
    if (problem) return problem;
    const label = text("label") || existing?.label || id;
    return {
      action,
      id,
      reason,
      importance,
      def: { id, label, hint: text("hint") || existing?.hint || label, kind: text("kind") || existing?.kind || "secret", pattern, ...(flags ? { flags } : {}) },
    };
  }
  if (!existing) return `No detector ${id}`;
  if (action === "remove" && existing.builtin) return `${id} is built in: disable it instead`;
  if (action === "enable" && existing.enabled) return `${id} is already on`;
  if (action === "disable" && !existing.enabled) return `${id} is already off`;
  return { action, id, reason, importance };
}

/** The approval's text: what changes, what it would match now, and why. */
function describeProposal(proposal: Proposal, pages: Tab[]): { title: string; detail: string } | string {
  const existing = vault().detectors.get(proposal.id);
  const lines: string[] = [];
  let title: string;
  if (proposal.def) {
    const found = sampleMatches(proposal.def.pattern, proposal.def.flags, pages, (value) => vault().detectors.isUnflagged(value));
    if (found.values > PROPOSE_MAX_MATCHES) {
      return `That pattern matches more than ${PROPOSE_MAX_MATCHES} different values in the user's pages: too broad for a secret format. Make it stricter.`;
    }
    title = `${proposal.action === "add" ? "Add" : "Change"} detector: ${proposal.def.label}`;
    if (existing && existing.pattern !== proposal.def.pattern) lines.push(`Was: /${existing.pattern}/${existing.flags ?? ""}`);
    lines.push(`Pattern: /${proposal.def.pattern}/${proposal.def.flags ?? ""}`, `Agents would see a match as ⟦p:… ${proposal.def.hint}⟧.`);
    lines.push(
      found.values
        ? `Matches ${found.values} value${found.values === 1 ? "" : "s"} on ${found.pages} page${found.pages === 1 ? "" : "s"} now, such as:\n${found.samples.map((sample) => `• ${sample.text} on ${sample.page}`).join("\n")}`
        : "Matches nothing in your pages now."
    );
  } else {
    const view = existing!;
    const verb = { enable: "Turn on", disable: "Turn off", remove: "Remove" }[proposal.action as "enable" | "disable" | "remove"];
    title = `${verb} detector: ${view.label}`;
    lines.push(`Pattern: /${view.pattern}/${view.flags ?? ""}`);
    lines.push(
      view.matches
        ? `So far: ${view.matches} match${view.matches === 1 ? "" : "es"}, ${view.unflags} unflagged (${Math.round((view.falseFlagRate ?? 0) * 100)}% false flags).`
        : "No matches so far."
    );
    if (proposal.action !== "enable") lines.push("Values it already protected stay protected.");
  }
  if (proposal.reason) lines.push(`Why: ${proposal.reason}`);
  return { title, detail: lines.join("\n") };
}

/**
 * Detectors (#1047):
 * GET /detectors: every detector with its counts and change history (agents too; patterns aren't secret).
 * PUT /detectors/:id { enabled }, POST /detectors (add or change a custom one), DELETE /detectors/:id: the user's.
 * POST /detectors/propose: an agent's change, applied only once the user approves it in the chat.
 */
function detectorRouter(host: VaultRoutesHost): express.Router {
  const router = express.Router();
  const userOnly = (req: express.Request, res: express.Response): boolean => {
    if (identify(req).viewer !== "agent") return true;
    res.status(403).json({ error: "Agents change detectors with detector_propose, which asks the user." });
    return false;
  };
  /** A detector that just went on looks at every page now, rather than at each one's next write or read. */
  const rescan = () =>
    setImmediate(() => {
      for (const tab of host.allPages()) vault().detectDeep([tab.title, tab.html, tab.state]);
    });
  router.get("/", (_req, res) => {
    res.json({ detectors: vault().detectors.list(), suggestOffRate: SUGGEST_OFF_RATE, suggestOffMinMatches: SUGGEST_OFF_MIN_MATCHES });
  });
  router.put("/:id", (req, res) => {
    if (!userOnly(req, res)) return;
    const enabled = (req.body as Record<string, unknown> | undefined)?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    try {
      const detector = vault().detectors.setEnabled(req.params.id, enabled, "user");
      if (enabled) rescan();
      res.json({ detector });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });
  router.post("/", (req, res) => {
    if (!userOnly(req, res)) return;
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const exists = vault().detectors.get(String(body.id ?? "").trim().toLowerCase());
    const proposal = readProposal({ ...body, action: exists ? "edit" : "add" });
    if (typeof proposal === "string") {
      res.status(400).json({ error: proposal });
      return;
    }
    try {
      const detector = vault().detectors.put(proposal.def!, "user");
      rescan();
      res.json({ detector });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  router.delete("/:id", (req, res) => {
    if (!userOnly(req, res)) return;
    if (!vault().detectors.remove(req.params.id)) {
      res.status(404).json({ error: "No such custom detector (built-in ones can only be turned off)" });
      return;
    }
    res.json({ ok: true });
  });
  router.post("/propose", async (req, res) => {
    const caller = identify(req);
    if (caller.viewer !== "agent" || !caller.thread) {
      res.status(403).json({ error: "detector_propose is for Scribe chat threads; the user changes detectors in Settings." });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const proposal = readProposal(body);
    if (typeof proposal === "string") {
      res.status(400).json({ error: proposal });
      return;
    }
    let ask: { title: string; detail: string } | string;
    try {
      ask = describeProposal(proposal, host.allPages());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (typeof ask === "string") {
      res.status(400).json({ error: ask });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    try {
      const answer = await host.approve(caller.thread, { ...ask, importance: proposal.importance }, abort.signal);
      if (!answer.allowed) {
        if (!res.writableEnded) res.json({ applied: false, message: answer.message });
        return;
      }
      const by = `${host.agentName(req)} (approved by the user)`;
      const detectors = vault().detectors;
      let detector: DetectorView | undefined;
      if (proposal.def) detector = detectors.put(proposal.def, by);
      else if (proposal.action === "remove") detectors.remove(proposal.id);
      else detector = detectors.setEnabled(proposal.id, proposal.action === "enable", by);
      if (proposal.def || proposal.action === "enable") rescan();
      if (!res.writableEnded) res.json({ applied: true, ...(detector ? { detector: detectorSummary(detector) } : {}), ...(answer.message ? { note: answer.message } : {}) });
    } catch (err) {
      if (!res.writableEnded) res.status(400).json({ error: (err as Error).message });
    } finally {
      res.off("close", onClientGone);
    }
  });
  return router;
}
