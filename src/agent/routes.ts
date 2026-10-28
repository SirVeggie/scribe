import fs from "node:fs";
import path from "node:path";
import express from "express";
import { listPermissions, setRules } from "./permissions.js";
import { McpPermissions } from "./mcpPermissions.js";
import type { AgentHost } from "./host.js";
import { shellOrigins } from "../config.js";
import { identify } from "../callers.js";
import { toMeta } from "../types.js";
import { browserHttpStatus, ensureBrowserView, browserControl, browserNavigate, browserUserTabs, browserFit, browserInput, browserViews, closeThreadBrowser, watchBrowser, type BrowserInput } from "../browser.js";
import { diffPatch, findRepo, workingChanges } from "./git.js";
import { findSvnRoot, svnBase, svnRevision, svnWorkingChanges } from "./svn.js";
import { searchWorkspaceFiles } from "./workspaceFiles.js";
import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, filePath, guessMimeType, isTextFile } from "./attachments.js";
import type { ChatFile, ChatImage, ContextChip, ProviderId, Thread, ThreadScope } from "./types.js";
import { isPlainRecord, isProviderId, parseApproval, parseMode, wantsPlan } from "./types.js";
import { parseWebAccess } from "./webAccess.js";
import { applyImport, removeCursorImports, cleanLayer, DEFAULT_MODES, importCandidates, mcpFilePath, readMcpFile, setServerEnabled, writeMcpFile, type McpFile, type McpImportCandidate } from "./mcpConfig.js";
import { workspaceKey, type ThreadPatch } from "./prefs.js";
import { hookCoverage } from "./hooks.js";
import { copySkill, createSkill, editableKind, readHarnessFile, readSmallText, removeSkill, writeHarnessFile } from "./harnessFiles.js";
import { store } from "../store.js";
import { componentHost, PORT } from "../config.js";
import { plugins } from "../plugins/current.js";
import { relayComponentEvents } from "../plugins/componentHost.js";
import { AI_CHUNKS, AI_QUERY_MAX, aiChunkPrompt, aiSearchPrompt, chunkDigest, digestPages, pageDigest, parseAiHits } from "../aiSearch.js";
import { refreshSearchIndex, searchIndex } from "../search/service.js";
import { chunkPage } from "../search/chunker.js";
import { checkSdkUpdates } from "./sdkUpdates.js";
import { cardContext } from "./cardContext.js";
import { DEFAULT_INTELLIJ, intellijSettings, intellijLauncher, intellijDiffArgs, intellijExportDiff, intellijFileArgs, intellijProjectFiles, launchIntelliJ } from "./intellij.js";

type AiPassage = { id: string; digest: string; kind: string; anchor: string | null; headingId: string | null; label: string };

/**
 * The passages closest to the question, for the palette's `?` search. Null when semantic search is off, has
 * failed, finds nothing, or has indexed too little of the Library to stand in for every page.
 */
async function aiPassages(query: string): Promise<AiPassage[] | null> {
  try {
    refreshSearchIndex();
    const index = searchIndex.status();
    if (!index.enabled || index.indexedPages < index.totalPages * 0.9) return null;
    const hits = await searchIndex.query(query, "chunks", (id) => !!store.get(id, "agent"), AI_CHUNKS, false);
    // The index keeps a 200-character snippet; the chunker gives the passage's own text again.
    const texts = new Map<string, Map<string, string>>();
    const passages: AiPassage[] = [];
    for (const hit of hits) {
      const tab = store.get(hit.tab_id, "agent");
      if (!tab) continue;
      const folder = store.folderPath(tab.folderId);
      let byKey = texts.get(tab.id);
      if (!byKey) {
        byKey = new Map(chunkPage(tab, folder, store.searchDeclaration(tab)).map((chunk) => [chunk.key, chunk.text]));
        texts.set(tab.id, byKey);
      }
      const digest = chunkDigest({ title: tab.title || tab.key, folder }, { kind: hit.kind, label: hit.label, text: byKey.get(hit.chunk_key) ?? hit.snippet });
      passages.push({ id: tab.id, digest, kind: hit.kind, anchor: hit.anchor, headingId: hit.heading_id, label: hit.label });
    }
    return passages.length ? passages : null;
  } catch {
    return null;
  }
}

function mcpView() {
  const { error, ...file } = readMcpFile();
  return { path: mcpFilePath(), file, defaultModes: DEFAULT_MODES, ...(error ? { error } : {}) };
}

/** The saved file, to change; refused while it does not parse, so a hand edit with a typo is not overwritten. */
function writableMcpFile(): McpFile {
  const { error, ...file } = readMcpFile();
  if (error) throw new Error(`${mcpFilePath()} does not parse, so it is left alone: ${error}`);
  return { mcpServers: { ...file.mcpServers }, workspaces: { ...file.workspaces } };
}

/** /api/agent/* for the board shell. The content origin gate keeps tab pages out of these. */
export function agentRouter(host: AgentHost): express.Router {
  const router = express.Router();
  router.use(shellOnly);
  // Room for a message's files as base64 (MAX_MESSAGE_BYTES, plus a third).
  router.use(express.json({ limit: "80mb" }));

  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
    (req: express.Request, res: express.Response) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .then((result) => {
          if (!res.headersSent) res.json(result ?? { ok: true });
        })
        .catch((err: Error) => {
          if (res.headersSent) return;
          const browserRoute = /\/browser(?:\/|$)/.test(req.path);
          const status = /not found/.test(err.message) ? 404 : browserRoute ? browserHttpStatus(err.message) : 400;
          // Playwright errors carry a call log after the first line; the browser view shows only the message.
          res.status(status).json({ error: browserRoute ? err.message.split("\n")[0].replace(/^page\.\w+: /, "") : err.message });
        });
    };

  const pageWorkspace = (id: string) => (store.get(id) ?? store.getDraft(id))?.workspace || null;
  router.get("/integrations", wrap(() => ({ intellij: intellijSettings(host.db.getSetting("integration.intellij", DEFAULT_INTELLIJ)) })));
  router.put("/integrations", wrap((req) => {
    const settings = intellijSettings(req.body?.intellij);
    host.db.setSetting("integration.intellij", settings);
    return { intellij: settings };
  }));
  router.post("/integrations/intellij/open", wrap(async (req) => {
    const settings = intellijSettings(host.db.getSetting("integration.intellij", DEFAULT_INTELLIJ));
    if (!settings.enabled) throw new Error("Enable IntelliJ in Settings → Integrations first.");
    const body = isPlainRecord(req.body) ? req.body : {};
    if (body.mode !== "diff" && body.mode !== "file") throw new Error("Choose diff or file.");
    if (typeof body.path !== "string" || !body.path) throw new Error("Choose a file to open.");
    // An svn working copy's changes: the file against its checked-out base (BASE).
    if (typeof body.svn === "string" && body.svn) {
      const dir = body.svn;
      if (!findSvnRoot(dir)) throw new Error("This folder is not an svn working copy.");
      const launcher = await intellijLauncher(settings.launcher);
      let args: string[];
      if (body.mode === "file") args = await intellijFileArgs(dir, body.path, body.line, body.column);
      else {
        const rel = path.relative(dir, path.resolve(dir, body.path));
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Choose a file inside this workspace.");
        const before = (await svnBase(dir, rel)) ?? Buffer.alloc(0);
        let after = Buffer.alloc(0);
        try { after = await fs.promises.readFile(path.join(dir, rel)); } catch { /* deleted */ }
        args = await intellijExportDiff(body.path, before, after);
      }
      await launchIntelliJ(launcher, args);
      return { ok: true };
    }
    let repo = typeof body.repo === "string" ? await findRepo(body.repo) : null;
    let from = typeof body.from === "string" ? body.from : "";
    let to = typeof body.to === "string" ? body.to : "";
    let versions: { before: Buffer; after: Buffer } | null = null;
    if (typeof body.pageId === "string" && !repo) {
      // A code reference on a page: its path is relative to the page's workspace.
      repo = pageWorkspace(body.pageId);
      if (!repo) throw new Error("This page has no workspace to open the file from.");
    } else if (typeof body.threadId === "string" && !repo && body.workspace === true) {
      // A code reference in a chat: its path is relative to the thread's workspace.
      repo = host.getThread(body.threadId)?.cwd || null;
      if (!repo) throw new Error("This chat has no workspace to open the file from.");
    } else if (typeof body.threadId === "string" && !repo) {
      const thread = host.getThread(body.threadId);
      if (!thread) throw new Error("Thread not found.");
      const turnId = typeof body.turnId === "string" ? body.turnId : undefined;
      const changes = await host.changes(thread.id, turnId);
      repo = changes.repo || thread.cwd;
      from = changes.from || "";
      to = changes.to || "";
      // Workspaces without git (SVN, plain folders) keep the edited files' versions instead.
      if (body.mode === "diff" && !(from && to)) versions = host.fileVersions(thread.id, body.path, turnId);
    }
    if (!repo) throw new Error("This diff has no local workspace to open in IntelliJ.");
    const launcher = await intellijLauncher(settings.launcher);
    const args = versions ? await intellijExportDiff(body.path, versions.before, versions.after)
      : body.mode === "diff" ? await intellijDiffArgs(repo, from, to, body.path)
      : await intellijFileArgs(repo, body.path, body.line, body.column);
    await launchIntelliJ(launcher, args);
    return { ok: true };
  }));

  /** Which of a diff's or a chat's files are in an IntelliJ project, so only those offer IntelliJ actions. */
  router.post("/integrations/intellij/projects", wrap(async (req) => {
    const body = isPlainRecord(req.body) ? req.body : {};
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string" && !!p).slice(0, 500) : [];
    const settings = intellijSettings(host.db.getSetting("integration.intellij", DEFAULT_INTELLIJ));
    if (!settings.enabled || !paths.length) return { files: Object.fromEntries(paths.map(p => [p, false])) };
    let root: string | null = null;
    if (typeof body.svn === "string" && body.svn) root = findSvnRoot(body.svn) ? body.svn : null;
    else if (typeof body.repo === "string" && body.repo) root = await findRepo(body.repo);
    else if (typeof body.pageId === "string") root = pageWorkspace(body.pageId);
    else if (typeof body.threadId === "string") {
      const thread = host.getThread(body.threadId);
      if (!thread) throw new Error("Thread not found.");
      const turnId = typeof body.turnId === "string" ? body.turnId : undefined;
      root = body.workspace === true ? thread.cwd || null : (await host.changes(thread.id, turnId)).repo || thread.cwd || null;
    }
    return { files: root ? await intellijProjectFiles(root, paths) : Object.fromEntries(paths.map(p => [p, false])) };
  }));

  router.get(
    "/config",
    wrap(async () => ({
      providers: await host.providerStatus(),
      prefs: host.prefs(),
      models: { claude: host.cachedModels("claude"), cursor: host.cachedModels("cursor"), codex: host.cachedModels("codex"), pi: host.cachedModels("pi") },
      limits: host.limits(),
      nativePlans: host.nativePlans(),
    }))
  );

  router.get("/sdk-updates", wrap((req) => checkSdkUpdates(req.query.refresh === "1")));

  // The palette's `?` search (#245): one summarizer call over the passages closest to the question (#374), or,
  // with semantic search off, over a digest of every page the agent may see.
  router.post(
    "/palette-search",
    wrap(async (req, res) => {
      const query = typeof req.body?.query === "string" ? req.body.query.trim().slice(0, AI_QUERY_MAX) : "";
      if (!query) throw new Error("query is required");
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      const started = Date.now();
      const passages = await aiPassages(query);
      if (passages) {
        const { text, model } = await host.summarize(aiChunkPrompt(query, passages.map((p) => p.digest)), abort.signal);
        const hits = parseAiHits(text, passages.map((p) => p.id)).map(({ id, reason, index }) => {
          const { kind, anchor, headingId, label } = passages[index];
          return { id, reason, kind, anchor, headingId, label };
        });
        return { hits, model, pages: new Set(passages.map((p) => p.id)).size, chunks: passages.length, ms: Date.now() - started };
      }
      const pages = digestPages([...store.listOpenTabs("agent"), ...store.listClosedTabs("agent")]);
      const prompt = aiSearchPrompt(query, pages.map((tab) => pageDigest(tab, store.folderPath(tab.folderId))));
      const { text, model } = await host.summarize(prompt, abort.signal);
      const hits = parseAiHits(text, pages.map((tab) => tab.id)).map(({ id, reason }) => ({ id, reason }));
      return { hits, model, pages: pages.length, ms: Date.now() - started };
    })
  );

  // Cursor's browser login (the SDK's Cursor.auth.login); the URL also opens in the system browser.
  router.post("/cursor/login", wrap(() => host.cursorLogin()));
  // Codex's ChatGPT login (bundled `codex login`); the URL also opens in the system browser.
  router.post("/codex/login", wrap(() => host.codexLogin()));
  router.post("/claude/login", wrap(() => host.claudeLogin()));
  // Native's subscription logins (Pi's OAuth flows, tokens in Scribe's Pi auth.json).
  router.get("/pi/logins", wrap(async () => ({ logins: await host.piLogins() })));
  router.post("/pi/logins/:id", wrap(async (req) => ({ login: await host.piLogin(req.params.id) })));
  router.post(
    "/pi/logins/:id/answer",
    wrap((req) => {
      const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
      if (!value) throw new Error("value is required");
      host.piLoginAnswer(req.params.id, value);
      return { ok: true };
    })
  );
  router.post(
    "/pi/logins/:id/cancel",
    wrap((req) => {
      host.piLoginCancel(req.params.id);
      return { ok: true };
    })
  );
  router.delete(
    "/pi/logins/:id",
    wrap(async (req) => {
      await host.piLogout(req.params.id);
      return { ok: true };
    })
  );

  // The providers' own allow / deny / ask lists (Claude Code settings, Cursor CLI config).
  router.get("/permissions", wrap((req) => ({ sets: listPermissions(typeof req.query.cwd === "string" ? req.query.cwd : null) })));

  router.put(
    "/permissions",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const provider = body.provider === "cursor" ? "cursor" : body.provider === "claude" ? "claude" : null;
      if (!provider) throw new Error("Unknown provider");
      const scope = body.scope === "project" || body.scope === "local" ? body.scope : "user";
      const kind = body.kind === "deny" || body.kind === "ask" ? body.kind : "allow";
      return { set: setRules({ provider, scope, kind, cwd: typeof body.cwd === "string" ? body.cwd : null, rules: body.rules }) };
    })
  );

  // Scribe's MCP servers (data/agent/mcp.json): the global list and one per workspace.
  router.get("/mcp", wrap(() => mcpView()));
  router.get("/mcp/permissions", wrap(() => host.mcpGrants()));
  router.delete("/mcp/permissions", wrap((req) => {
    const { key, tool, thread } = isPlainRecord(req.body) ? req.body : {};
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) ||
      (typeof tool === "string" && !!tool) === (typeof thread === "string" && !!thread)) throw new Error("Expected a grant key and either a tool or thread.");
    new McpPermissions().revoke(key, typeof tool === "string" ? tool : undefined, typeof thread === "string" ? thread : undefined);
    return host.mcpGrants();
  }));

  router.put(
    "/mcp/layer",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const scope = typeof body.scope === "string" && body.scope ? body.scope : "global";
      const servers = cleanLayer({ mcpServers: body.servers }).mcpServers;
      const file = writableMcpFile();
      if (scope === "global") file.mcpServers = servers;
      else if (Object.keys(servers).length) file.workspaces[workspaceKey(scope)] = { path: scope, mcpServers: servers };
      else delete file.workspaces[workspaceKey(scope)];
      writeMcpFile(file);
      return mcpView();
    })
  );

  // One server's switch on the harness view: off for a workspace alone, or where the server is defined.
  router.put(
    "/mcp/enabled",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (typeof body.name !== "string" || !body.name) throw new Error("name is required");
      writeMcpFile(setServerEnabled(writableMcpFile(), body.name, typeof body.cwd === "string" && body.cwd ? body.cwd : null, body.on === true));
      return mcpView();
    })
  );

  router.get(
    "/mcp/import",
    wrap((req) => {
      const dirs = ([] as unknown[]).concat(req.query.cwd ?? []).filter((d): d is string => typeof d === "string" && d.length > 0);
      return { candidates: importCandidates(dirs) };
    })
  );

  router.post(
    "/mcp/import",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const items = Array.isArray(body.items) ? body.items.filter(isPlainRecord) : [];
      const picked = items.flatMap((item) => (typeof item.scope === "string" && typeof item.name === "string" ? [{ scope: item.scope, name: item.name, server: item.server }] : []));
      writeMcpFile(applyImport(writableMcpFile(), picked));
      return mcpView();
    })
  );

  router.post(
    "/mcp/import/cursor-cleanup",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (!Array.isArray(body.items) || !body.items.every((item) => isPlainRecord(item) && item.source === "cursor" &&
        typeof item.file === "string" && typeof item.scope === "string" && typeof item.name === "string" && typeof item.revision === "string")) {
        throw new Error("Expected confirmed Cursor imports");
      }
      return { results: removeCursorImports(body.items as McpImportCandidate[], writableMcpFile()) };
    })
  );

  router.put(
    "/prefs",
    wrap((req) => host.setPrefs(isPlainRecord(req.body) ? (req.body as never) : {}))
  );

  router.post(
    "/prefs/remember",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return {
        prefs: host.rememberDraft({
          ...threadPatch(body),
          ...(body.scope ? { scope: parseScope(body.scope) } : {}),
        }),
      };
    })
  );

  router.get(
    "/models",
    wrap(async (req) => {
      const provider = parseProvider(req.query.provider);
      return { provider, models: await host.models(provider, req.query.refresh === "1") };
    })
  );

  // The user's hook rules (hooks.ts), and what each provider lets a hook hold.
  const hooksView = () => ({ ...host.hookSettings(), coverage: hookCoverage() });
  router.get("/hooks", wrap(hooksView));
  router.put(
    "/hooks",
    wrap((req) => {
      host.setPrefs({ hookRules: isPlainRecord(req.body) ? (req.body.rules as never) : [] });
      return hooksView();
    })
  );

  // Native harness model sources (OpenAI-compatible endpoints). API keys go in, never out: the list only says whether one is set.
  router.get("/model-sources", wrap(() => ({ sources: host.modelSourceViews() })));
  router.post("/model-sources", wrap((req) => ({ source: host.saveModelSource(null, req.body) })));
  router.put("/model-sources/:id", wrap((req) => ({ source: host.saveModelSource(req.params.id, req.body) })));
  router.delete(
    "/model-sources/:id",
    wrap((req) => {
      host.deleteModelSource(req.params.id);
      return { ok: true };
    })
  );

  // Shared agent memory (#104): the notes every chat gets in its instructions.
  router.get("/memories", wrap(() => ({ memories: host.memories(), targets: host.memoryTargets() })));
  router.post("/memories", wrap((req) => ({ memory: host.saveUserMemory(null, req.body) })));
  router.put("/memories/:id", wrap((req) => ({ memory: host.saveUserMemory(req.params.id, req.body) })));
  router.delete(
    "/memories/:id",
    wrap((req) => {
      host.deleteMemory(req.params.id);
      return { ok: true };
    })
  );

  // The agent harness view (#456): what chats start with and how the stored threads used it.
  router.post("/context/seed", wrap((req) => {
    const body = isPlainRecord(req.body) ? req.body : {};
    return host.contextSeed({ ...threadPatch(body), ...(body.scope ? { scope: parseScope(body.scope) } : {}) }, typeof body.threadId === "string" ? body.threadId : undefined);
  }));
  router.get(
    "/harness/stats",
    wrap((req) => {
      const days = Number(req.query.days);
      return host.harnessStats(Number.isFinite(days) && days > 0 ? days : null);
    })
  );
  const rangeDays = (req: express.Request) => {
    const days = Number(req.query.days);
    return Number.isFinite(days) && days > 0 ? days : null;
  };
  router.get("/harness/usage", wrap((req) => host.usageHistory(rangeDays(req))));
  router.get(
    "/harness/usage.csv",
    wrap((req, res) => {
      const days = rangeDays(req);
      const csv = host.usageCsv(days);
      res.attachment(`scribe-usage-${days ? `${days}d` : "all"}-${new Date().toISOString().slice(0, 10)}.csv`);
      res.type("text/csv; charset=utf-8").send(csv);
    })
  );
  router.post(
    "/harness/context",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return host.harnessContext({ ...threadPatch(body), ...(body.scope ? { scope: parseScope(body.scope) } : {}) });
    })
  );
  router.post(
    "/harness/measure",
    wrap(async (req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return { measure: await host.harnessMeasure({ ...threadPatch(body), ...(body.scope ? { scope: parseScope(body.scope) } : {}) }, body.plain === true) };
    })
  );
  router.get("/harness/skills", wrap((req) => host.skills(typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : null)));

  // Scribe's own skills (#239): folders in dataDir/skills, given to chats through skill_read.
  const skillsOf = () => host.scribeSkills;
  /** "builtin" for a file of the built-in skill, a skill id for one of a Scribe skill's, else null. */
  const scribeSkillFile = (file: string): string | null => {
    if (!path.isAbsolute(file)) return null;
    if (skillsOf().isBuiltinFile(file)) return "builtin";
    return skillsOf().ownerOf(file);
  };
  router.get("/scribe-skills", wrap(() => ({ skills: skillsOf().list(), trash: skillsOf().list({ trash: true }), root: skillsOf().root })));
  router.post(
    "/scribe-skills",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return { skill: skillsOf().create(body.name, body.description) };
    })
  );
  router.post(
    "/scribe-skills/copy",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const file = String(body.file ?? "");
      // Only a skill in a folder a provider reads (or the built-in): not any SKILL.md on disk.
      if (!skillsOf().isBuiltinFile(file) && editableKind(file, workspaceOf(body.cwd)) !== "skill") throw new Error("Not a skill in one of the providers' folders.");
      return { skill: skillsOf().copyFrom(file) };
    })
  );
  router.post(
    "/scribe-skills/import",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return { skill: skillsOf().import(body.path) };
    })
  );
  router.post(
    "/scribe-skills/:id/:op",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const id = String(req.params.id);
      const skills = skillsOf();
      switch (req.params.op) {
        case "enabled":
          if (typeof body.enabled !== "boolean") throw new Error("enabled is required");
          skills.setEnabled(id, body.enabled);
          return { ok: true };
        case "duplicate":
          return { skill: skills.duplicate(id) };
        case "export":
          return skills.export(id, body.path);
        case "remove":
          skills.remove(id);
          return { ok: true };
        case "restore":
          return { skill: skills.restore(id) };
        case "purge":
          skills.purge(id);
          return { ok: true };
        default:
          throw new Error(`Unknown skill action: ${req.params.op}`);
      }
    })
  );

  // What the view changes (#495): skills in the providers' folders, and the instruction files they load.
  const workspaceOf = (value: unknown) => ({ workspace: typeof value === "string" && value ? value : null });
  router.post(
    "/harness/skills",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return createSkill(String(body.folder ?? ""), String(body.name ?? ""), String(body.description ?? ""), workspaceOf(body.cwd));
    })
  );
  router.post(
    "/harness/skills/copy",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return copySkill(String(body.file ?? ""), String(body.folder ?? ""), workspaceOf(body.cwd));
    })
  );
  router.post(
    "/harness/skills/remove",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return removeSkill(String(body.file ?? ""), workspaceOf(body.cwd));
    })
  );
  router.get(
    "/harness/file",
    wrap((req) => {
      const file = String(req.query.path ?? "");
      // A Scribe skill's files are edited here too; the built-in's are only shown.
      const scribe = scribeSkillFile(file);
      if (scribe) return { path: file, kind: "skill", text: readSmallText(file), ...(scribe === "builtin" ? { readOnly: true } : {}) };
      return readHarnessFile(file, workspaceOf(req.query.cwd));
    })
  );
  router.put(
    "/harness/file",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const file = String(body.path ?? "");
      const scribe = scribeSkillFile(file);
      if (scribe === "builtin") throw new Error("The built-in skill is read-only. Copy it to Scribe to change it.");
      if (scribe) {
        if (typeof body.text !== "string") throw new Error("text is required");
        if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
        fs.writeFileSync(file, body.text);
        host.scribeSkills.refresh(scribe);
        return { path: file };
      }
      return writeHarnessFile(file, body.text as string, workspaceOf(body.cwd));
    })
  );
  router.post(
    "/harness/mcp/probe",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (typeof body.name !== "string" || !body.name) throw new Error("name is required");
      return host.harnessProbe(body.name, typeof body.cwd === "string" && body.cwd ? body.cwd : null);
    })
  );

  router.get("/threads", wrap(() => ({ threads: host.listThreads() })));

  router.get("/thread-search", wrap((req) => ({ hits: host.searchThreadMessages(req.query.q) })));

  router.get("/commands", wrap((req) => ({ commands: host.providerCommands(parseProvider(req.query.provider)) })));

  router.post(
    "/threads",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return {
        thread: host.createThread(
          {
            ...threadPatch(body),
            ...(body.scope ? { scope: parseScope(body.scope) } : {}),
            // A board worker the user set to use helpers without asking.
            ...(body.helpersAllowed === true ? { helpersAllowed: true } : {}),
            // A one-off chat a page starts with no tools at all (#729).
            ...(body.noTools === true ? { noTools: true } : {}),
          },
          { remember: body.remember !== false }
        ),
      };
    })
  );

  router.post(
    "/warm",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      host.warmDraft({ ...threadPatch(body), ...(body.scope ? { scope: parseScope(body.scope) } : {}) });
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/warm",
    wrap(async (req) => {
      await host.warm(req.params.id);
      return { ok: true };
    })
  );

  router.get(
    "/threads/:id",
    wrap((req) => {
      const detail = host.threadDetail(req.params.id);
      if (!detail) throw new Error(`thread not found: ${req.params.id}`);
      return detail;
    })
  );

  router.patch(
    "/threads/:id",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      // revokeGrant: a key from the thread's grants, taken back before the other fields apply.
      const patch = threadPatch(body);
      if (typeof body.revokeGrant === "string") {
        const thread = host.revokeGrant(req.params.id, body.revokeGrant);
        if (!Object.keys(patch).length) return { thread };
      }
      return { thread: host.updateThread(req.params.id, patch) };
    })
  );

  router.delete(
    "/threads/:id",
    wrap(async (req) => {
      await host.deleteThread(req.params.id);
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/fork",
    wrap((req) => {
      const patch = threadPatch(isPlainRecord(req.body) ? req.body : {});
      return { thread: host.fork(req.params.id, { provider: patch.provider, model: patch.model, mode: patch.mode }) };
    })
  );

  router.post(
    "/threads/:id/read",
    wrap((req) => {
      host.markRead(req.params.id);
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/messages",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const images: ChatImage[] = Array.isArray(body.images)
        ? body.images
            .filter(isPlainRecord)
            .map((img) => ({ name: String(img.name ?? "image"), mimeType: String(img.mimeType ?? "image/png"), data: String(img.data ?? "") }))
            .filter((img) => img.data && /^image\//.test(img.mimeType))
        : [];
      const files: ChatFile[] = Array.isArray(body.files)
        ? body.files
            .filter(isPlainRecord)
            .map((file) => {
              const name = String(file.name ?? "file");
              return { name, mimeType: guessMimeType(name, String(file.mimeType ?? "")), data: String(file.data ?? "") };
            })
            .filter((file) => file.data)
        : [];
      if (images.length + files.length > MAX_FILES_PER_MESSAGE) throw new Error(`Up to ${MAX_FILES_PER_MESSAGE} files per message`);
      let total = 0;
      for (const file of [...images, ...files]) {
        const bytes = Math.floor((file.data.length * 3) / 4);
        const max = file.mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (bytes > max) throw new Error(`${file.name} is over ${max / 1024 / 1024} MB`);
        total += bytes;
      }
      if (total > MAX_MESSAGE_BYTES) throw new Error(`A message's files must add up to under ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`);
      const context = Array.isArray(body.context) ? (body.context.filter(isPlainRecord) as ContextChip[]) : [];
      let text = String(body.text ?? "");
      if (body.cardContext != null) {
        const thread = host.getThread(req.params.id);
        if (!thread) throw new Error("Thread not found");
        const snapshot = cardContext(store, thread.scope, body.cardContext, [...images, ...files]);
        text += "\n\n" + snapshot.text;
        images.push(...snapshot.images);
      }
      // The board sends from: "page" for messages a page's own code sent through board.agent.
      // plan: the composer's Plan chip (#721); false drops a planNext the user turned off.
      if (body.from !== "page") host.interact(req.params.id);
      return host.send(req.params.id, { text, images, files, context, ...(body.from === "page" ? { from: "page" as const } : {}), ...(body.dock === true ? { dock: true } : {}), ...(typeof body.plan === "boolean" ? { plan: body.plan } : {}) });
    })
  );

  // A Kanban board's card comment for the thread working on the card, or Continue for the one that worked on it.
  router.post(
    "/threads/:id/card-message",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const num = Number(body.num);
      const board = String(body.board ?? "").trim();
      if (!Number.isInteger(num) || num < 1 || !board) throw new Error("A card number and board are required");
      const title = String(body.title ?? "").trim().slice(0, 200);
      const boardKey = String(body.boardKey ?? "").trim();
      const card = { num, board: board.slice(0, 200), ...(title ? { title } : {}), ...(boardKey ? { boardKey } : {}), ...(body.resume === true ? { resume: true } : {}) };
      return host.cardMessage(req.params.id, card, String(body.text ?? ""));
    })
  );

  // A file sent with a message, for the chat's previews. Shown inline; download is the viewer's choice.
  router.get(
    "/threads/:id/files/:fileId",
    wrap(async (req, res) => {
      const full = filePath(req.params.id, req.params.fileId);
      if (!full) throw new Error("File not found");
      const name = path.basename(full);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Text and HTML come back as plain text, so a preview never runs a sent file's scripts.
      res.type(isTextFile(name, "") ? "text/plain; charset=utf-8" : path.extname(name) || "application/octet-stream");
      await new Promise<void>((resolve, reject) => res.sendFile(full, (err) => (err ? reject(err) : resolve())));
    })
  );

  router.post(
    "/threads/:id/cancel",
    wrap(async (req) => {
      await host.cancel(req.params.id);
      return { ok: true };
    })
  );

  // Back to just before a message of the user's; the reply carries the message for editing or sending again.
  router.post(
    "/threads/:id/rewind",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return host.rewind(req.params.id, String(body.itemId ?? ""), { keepChanges: body.keepChanges === true });
    })
  );

  // A subagent or background command, by the id of the tool item that started it.
  router.post(
    "/threads/:id/tasks/:itemId/stop",
    wrap(async (req) => {
      await host.stopTask(req.params.id, req.params.itemId);
      return { ok: true };
    })
  );
  router.post("/threads/:id/tasks/:itemId/background", wrap((req) => host.backgroundTask(req.params.id, req.params.itemId)));

  // Enter on an empty composer while a turn runs: steer the first queued message in (again: send it now).
  router.post(
    "/threads/:id/steer",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : undefined;
      return host.steer(req.params.id, itemId);
    })
  );

  // Up on an empty composer: take the latest queued (or waiting steered) message back for editing.
  router.post("/threads/:id/withdraw", wrap((req) => host.withdraw(req.params.id, typeof req.body?.itemId === "string" ? req.body.itemId : undefined)));
  router.post("/threads/:id/queued/:itemId/edit", wrap((req) => host.beginQueuedEdit(req.params.id, req.params.itemId, req.body?.recover === true)));
  router.post("/threads/:id/queued/:itemId/edit-finish", wrap((req) => {
    if (typeof req.body?.token !== "string" || (req.body.text !== undefined && typeof req.body.text !== "string")) throw new Error("Invalid edit");
    host.finishQueuedEdit(req.params.id, req.params.itemId, req.body.token, req.body.text);
    return { ok: true };
  }));

  router.post(
    "/threads/:id/send-now",
    wrap(async (req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : undefined;
      await host.sendNow(req.params.id, itemId);
      return { ok: true };
    })
  );

  router.get("/threads/:id/commands", wrap(async (req) => ({ commands: await host.commands(req.params.id) })));

  router.get(
    "/threads/:id/changes",
    wrap((req) => host.changes(req.params.id, typeof req.query.turn === "string" && req.query.turn ? req.query.turn : undefined))
  );

  router.get(
    "/threads/:id/patch",
    wrap((req) =>
      host.patch(
        req.params.id,
        typeof req.query.turn === "string" && req.query.turn ? req.query.turn : undefined,
        typeof req.query.path === "string" && req.query.path ? req.query.path : undefined
      )
    )
  );

  router.get("/threads/:id/worktree", wrap((req) => host.worktreeInfo(req.params.id)));
  // Worktrees with changes and no turns for days (#686). remind=1 asks whether this window should bring them up now.
  router.get("/worktrees/stale", wrap((req) => host.staleWorktrees(req.query.remind === "1")));
  // A page hands its thread to Scribe to see through (limit waits, resumes, merges), or takes it back.
  router.post("/threads/:id/run", wrap((req) => ({ thread: host.watchPageThread(req.params.id, req.body ?? {}) })));
  router.delete("/threads/:id/run", wrap((req) => ({ thread: host.releasePageThread(req.params.id) })));

  // Browser view routes belong to the board; agents use /api/browser tools.
  router.use(["/threads/:id/browser", "/browsers"], (req, res, next) => {
    if (identify(req).viewer === "agent") { res.status(403).json({ error: "Only the board controls browser views" }); return; }
    next();
  });
  router.post("/threads/:id/browser/view", wrap(async req => {
    const thread = host.getThread(req.params.id);
    if (!thread) throw new Error("Thread not found");
    await ensureBrowserView(thread.id);
    return { tab: toMeta(store.openBrowserPage(thread.id, thread.title, { activate: false }).tab) };
  }));
  router.post("/threads/:id/browser/control", wrap(async req => {
    const action = req.body?.action;
    if (action !== "take" && action !== "handBack") throw new Error("action must be take or handBack");
    await browserControl(req.params.id, action === "take" ? "user" : "free");
    if (action === "handBack") host.handBackBrowser(req.params.id);
    return { ok: true };
  }));
  router.post("/threads/:id/browser/navigate", wrap(req => browserNavigate(req.params.id, req.body ?? {})));
  router.post("/threads/:id/browser/tabs", wrap(req => browserUserTabs(req.params.id, req.body ?? {})));
  router.post("/threads/:id/browser/fit", wrap(req => browserFit(req.params.id, req.body ?? {})));

  // The thread's agent browser, watched and driven from the chat (the agent drives it over MCP).
  router.get("/browsers", wrap(async () => ({ browsers: await browserViews() })));
  router.get("/threads/:id/browser/live", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const stop = watchBrowser(
      req.params.id,
      (frame) => send("frame", frame),
      (view) => send("view", view),
      { maxWidth: req.query.w === undefined ? undefined : Number(req.query.w), everyNthFrame: req.query.n === undefined ? undefined : Number(req.query.n) }
    );
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      stop();
    });
  });
  router.post("/threads/:id/browser/input", wrap((req) => browserInput(req.params.id, req.body as BrowserInput)));
  router.post("/threads/:id/browser/close", wrap(async (req) => {
    await closeThreadBrowser(req.params.id);
    return { ok: true };
  }));

  // Finish a thread's worktree: merge its branch into the base, or leave the branch for later.
  router.post(
    "/threads/:id/worktree",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (body.action !== "merge" && body.action !== "leave" && body.action !== "discard") throw new Error("action must be merge, leave or discard");
      return host.finishWorktree(req.params.id, body.action);
    })
  );

  router.post("/threads/:id/turns/:turnId/revert", wrap((req) => host.revertTurn(req.params.id, req.params.turnId)));
  router.post("/threads/:id/turns/:turnId/revert-page", wrap((req) => host.revertPage(req.params.id, req.params.turnId)));

  // Answering an approval or question in the chat counts for the Recent thread lists.
  const interactPending = (requestId: string) => {
    const threadId = host.pendingThreadId(requestId);
    if (threadId) host.interact(threadId);
  };

  router.post(
    "/approvals/:requestId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      interactPending(req.params.requestId);
      host.resolveApproval(req.params.requestId, String(body.optionId ?? ""), typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined);
      return { ok: true };
    })
  );

  router.get("/threads/:id/components/:itemId", wrap(req => host.componentView(req.params.id, req.params.itemId)));
  router.post("/threads/:id/components/:itemId/plugin", (req, res) => {
    const abort = new AbortController();
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", close); req.setTimeout(0); res.setTimeout(0);
    host.componentPluginAction(req.params.id, req.params.itemId, isPlainRecord(req.body) ? req.body : {}, abort.signal)
      .then(result => { if (!res.destroyed) res.json(result); })
      .catch(error => { if (!res.destroyed) res.status(400).json({ error: error.message }); })
      .finally(() => res.off("close", close));
  });
  router.get("/threads/:id/components/:itemId/events", async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      await host.componentPluginAction(req.params.id, req.params.itemId, { op: "listen" }, abort.signal);
      if (abort.signal.aborted) return;
      const initial = host.componentPlugin(req.params.id, req.params.itemId);
      const persistent = (current: typeof initial) => current.permission === "allow" || current.thread.approval === "full" || current.thread.pluginGrants?.includes(current.plugin);
      const once = !persistent(initial), initialApproval = initial.thread.approval, initialPermission = initial.permission;
      const consentTurn = host.activeTurnId(req.params.id);
      const valid = () => {
        try {
          const current = host.componentPlugin(req.params.id, req.params.itemId);
          return current.hash === initial.hash && (persistent(current) || (once && consentTurn !== undefined && host.activeTurnId(req.params.id) === consentTurn && current.thread.approval === initialApproval && current.permission === initialPermission));
        } catch { return false; }
      };
      relayComponentEvents(res, { plugins: plugins!, plugin: initial.plugin, definition: initial.definition, valid });
    } catch (error) { if (!res.headersSent) res.status(400).json({ error: (error as Error).message }); else res.end(); }
  });
  router.post("/threads/:id/components/:itemId", wrap(req => {
    const body = isPlainRecord(req.body) ? req.body : {};
    // Answering an inline component is the user's own interaction; its other calls are automatic.
    if (body.action === "reply" || body.action === "skip") host.interact(req.params.id);
    return host.updateComponent(req.params.id, req.params.itemId, body);
  }));
  router.post("/threads/:id/components/:itemId/expand", wrap(req => {
    const item = host.componentItem(req.params.id, req.params.itemId);
    const url = `http://${componentHost(item.id)}:${PORT}/component/${item.id}?thread=${encodeURIComponent(item.threadId)}`;
    const { tab } = store.openTempUrl(url, { activate: false });
    return { key: tab.key };
  }));

  router.post(
    "/questions/:requestId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      interactPending(req.params.requestId);
      if (body.skip === true) {
        host.resolveQuestion(req.params.requestId, { skipped: true, reason: typeof body.reason === "string" ? body.reason : undefined });
      } else {
        const answers: Record<string, string[]> = {};
        if (isPlainRecord(body.answers)) {
          for (const [key, value] of Object.entries(body.answers)) {
            answers[key] = Array.isArray(value) ? value.map(String) : [String(value)];
          }
        }
        const notes: Record<string, string> = {};
        if (isPlainRecord(body.notes)) {
          for (const [key, value] of Object.entries(body.notes)) {
            if (typeof value === "string" && value.trim()) notes[key] = value.trim();
          }
        }
        host.resolveQuestion(req.params.requestId, { answers, ...(Object.keys(notes).length ? { notes } : {}) });
      }
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/plans/:itemId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      host.interact(req.params.id);
      host.resolvePlan(req.params.id, req.params.itemId, { accepted: body.accepted === true, note: typeof body.note === "string" ? body.note : undefined });
      return { ok: true };
    })
  );

  router.get(
    "/git",
    wrap(async (req) => {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      const repo = await findRepo(cwd);
      if (!repo) {
        // An svn working copy: its changes under the workspace folder, against BASE.
        if (!findSvnRoot(cwd)) return { repo: null, vcs: null, files: [] };
        const [changes, revision] = await Promise.all([svnWorkingChanges(cwd), svnRevision(cwd)]);
        if (!changes) return { repo: null, vcs: "svn", svn: cwd, files: [], error: "Could not read the svn working copy. Is the svn command-line client installed?" };
        return { repo: null, vcs: "svn", svn: cwd, revision, ...changes };
      }
      // A worktree thread compares against the commit its branch started from, so its commits show too.
      const base = typeof req.query.base === "string" && /^[0-9a-f]{40,64}$/.test(req.query.base) ? req.query.base : undefined;
      const changes = await workingChanges(repo, base);
      return changes ? { repo, vcs: "git", ...changes } : { repo, vcs: "git", files: [], error: "Could not read the working copy" };
    })
  );

  // Which version control a workspace folder uses, so the UI offers only what fits.
  router.get(
    "/vcs",
    wrap(async (req) => {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      return { vcs: (await findRepo(cwd)) ? "git" : findSvnRoot(cwd) ? "svn" : null };
    })
  );

  router.get(
    "/git/patch",
    wrap(async (req) => {
      const repo = await findRepo(typeof req.query.repo === "string" ? req.query.repo : "");
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      if (!repo || !/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) throw new Error("repo, from and to are required");
      const file = typeof req.query.path === "string" && req.query.path ? [req.query.path] : [];
      return diffPatch(repo, from, to, file);
    })
  );

  /** Folder browser for the workspace picker. */
  router.get(
    "/fs",
    wrap(async (req) => {
      const raw = typeof req.query.path === "string" ? req.query.path.trim() : "";
      // Sending only needs to know whether the workspace exists, without listing it or probing git.
      if (req.query.check === "1" && raw) {
        try {
          return { exists: fs.statSync(raw).isDirectory() };
        } catch {
          return { exists: false };
        }
      }
      if (!raw) {
        if (process.platform === "win32") {
          const drives = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => fs.existsSync(d));
          return { path: "", parent: null, dirs: drives.map((d) => ({ name: d, path: d })), repo: null };
        }
        return listDir("/");
      }
      return listDir(raw);
    })
  );

  // Workspace folders that are gone, with where each one went when Scribe can tell (#338).
  router.get("/workspaces/missing", wrap(() => ({ missing: host.missingWorkspaces() })));

  router.post(
    "/workspaces/relocate",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (typeof body.from !== "string" || typeof body.to !== "string") throw new Error("from and to are required");
      return host.relocateWorkspace(body.from, body.to, { claudeSessions: body.claudeSessions !== false });
    })
  );

  router.post(
    "/workspaces/dismiss",
    wrap((req) => {
      if (typeof req.body?.path !== "string") throw new Error("path is required");
      host.dismissWorkspaceMove(req.body.path);
      return { ok: true };
    })
  );

  // Hide a workspace from the thread list and the workspace menus, or show it again (#507).
  router.post(
    "/workspaces/hide",
    wrap((req) => {
      if (typeof req.body?.path !== "string") throw new Error("path is required");
      return { prefs: host.setWorkspaceHidden(req.body.path, req.body.hidden !== false) };
    })
  );

  // Delete a workspace's threads for good; their numbers stay in thread_stats.
  router.post(
    "/workspaces/delete",
    wrap((req) => {
      if (typeof req.body?.path !== "string") throw new Error("path is required");
      return host.deleteWorkspace(req.body.path);
    })
  );

  /** What is kept of the threads deleted with their workspace: numbers, settings and dates. */
  router.get("/workspaces/deleted-stats", wrap(() => ({ threads: host.deletedThreadStats() })));

  /** Files under a workspace for the composer's @-mention picker. */
  router.get(
    "/fs/files",
    wrap(async (req) => {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      const query = typeof req.query.query === "string" ? req.query.query : "";
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) ? raw : undefined;
      return { files: await searchWorkspaceFiles(cwd, query, limit) };
    })
  );

  return router;
}

/**
 * Writes must come from the board shell: JSON (a cross-origin form cannot send it without a
 * preflight) and, when the browser says where it came from, one of the shell's origins (127.0.0.1
 * or localhost). Tab pages live on another origin, so this also keeps a page from starting or answering agent runs.
 */
function shellOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && !shellOrigins().includes(origin)) {
    res.status(403).json({ error: "Agent requests must come from the board" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Agent requests must be JSON" });
    return;
  }
  next();
}

async function listDir(dir: string): Promise<{ path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; repo: string | null; vcs: "git" | "svn" | null; exists: boolean }> {
  // "C:" alone means the current directory on C:, not its root.
  const abs = path.resolve(/^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir);
  let entries: fs.Dirent[] = [];
  let exists = true;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    exists = false;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && !entry.name.startsWith("$"))
    .map((entry) => ({ name: entry.name, path: path.join(abs, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, 500);
  const parent = path.dirname(abs);
  const repo = exists ? await findRepo(abs) : null;
  return { path: abs, parent: parent === abs ? "" : parent, dirs, repo, vcs: repo ? "git" : exists && findSvnRoot(abs) ? "svn" : null, exists };
}

function parseProvider(value: unknown): ProviderId {
  if (isProviderId(value)) return value;
  throw new Error("provider must be claude, cursor, codex, or pi");
}

function parseScope(value: unknown): ThreadScope {
  if (!isPlainRecord(value)) return { kind: "global", ref: null };
  const kind = value.kind;
  if (kind === "workspace" || kind === "folder" || kind === "page") {
    const ref = typeof value.ref === "string" && value.ref ? value.ref : null;
    // A workspace scope is a thread with no Scribe scope; with no folder it has no workspace either.
    if (kind === "workspace") return { kind, ref: ref ? path.normalize(ref) : null };
    if (!ref) throw new Error(`${kind} scope needs a ref`);
    return { kind, ref };
  }
  return { kind: "global", ref: null };
}

function threadPatch(body: Record<string, unknown>): ThreadPatch {
  const patch: ThreadPatch = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (isProviderId(body.provider)) patch.provider = body.provider;
  if (typeof body.model === "string" && body.model) patch.model = body.model;
  if (body.effort === null || typeof body.effort === "string") patch.effort = (body.effort as string | null) || null;
  if (isPlainRecord(body.modelParams)) {
    patch.modelParams = Object.fromEntries(Object.entries(body.modelParams).map(([k, v]) => [k, String(v)]));
  }
  // The rung decides (#719); older modes (ask, board) are read as rungs, and "plan" makes the next message a plan turn (#721).
  const mode = parseMode(body.mode);
  if (mode) patch.mode = mode;
  if (wantsPlan(body.mode) || body.planNext === true) patch.planNext = true;
  if (typeof body.customMode === "string" && body.customMode) patch.customMode = body.customMode;
  else if (body.customMode === null) patch.customMode = null;
  const approval = parseApproval(body.approval);
  if (approval) patch.approval = approval;
  const web = parseWebAccess(body.web);
  if (web) patch.web = web;
  if (typeof body.useWorktree === "boolean") patch.useWorktree = body.useWorktree;
  if (body.cwd === null || typeof body.cwd === "string") {
    const cwd = (body.cwd as string | null) || null;
    if (cwd && !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    patch.cwd = cwd;
  }
  if (body.scope !== undefined) patch.scope = parseScope(body.scope);
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (typeof body.hooksOff === "boolean") patch.hooksOff = body.hooksOff;
  if (Array.isArray(body.skills)) patch.skills = [...new Set(body.skills.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 100))].slice(0, 100);
  if (body.draft === null) patch.draft = null;
  else if (isPlainRecord(body.draft) && typeof body.draft.text === "string") {
    const context = Array.isArray(body.draft.context) ? (body.draft.context.filter(isPlainRecord) as ContextChip[]) : [];
    const text = body.draft.text.slice(0, MAX_DRAFT_TEXT);
    // The page only saves a draft the user changed, so this is when they last wrote in it.
    patch.draft = { text, ...(context.length ? { context } : {}), ...(text.trim() || context.length ? { at: Date.now() } : {}) };
  }
  return patch;
}

/** Most unsent composer text a thread keeps. */
const MAX_DRAFT_TEXT = 200_000;
