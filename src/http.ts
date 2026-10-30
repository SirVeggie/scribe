import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { componentSite } from "./components.js";
import { PageComponents } from "./pageComponents.js";
import { parseComponentInput } from "./agent/componentTool.js";
import { WebSocketServer, type WebSocket } from "ws";
import { isSafeAssetName, parseAssetInputs, prepareAssets, readStoredAsset, rewriteAssetRefs } from "./assets.js";
import { builtinWatchEnabled, watchBuiltinTemplates } from "./builtinTemplates.js";
import { exportAllFilename, exportFilename, parseImport } from "./boardExport.js";
import { guideSent, markGuideSent } from "./guideMemory.js";
import { AGENT_LABEL_HEADER, CONTENT_HOST, SESSION_HEADER, HOST, INSTALL_ROOT, MAX_IMPORT_BYTES, MAX_PAGE_ASSET_BYTES, PEER_PORT, PORT, REQUEST_TIMEOUT_MS, VERSION, PAGE_HOST_SUFFIX, baseUrl, dataDir, peerHostsOverride } from "./config.js";
import { skipInlinePageImage } from "./mcpImages.js";
import { pageAssetUrl, type PageAssetMeta, type PageAssetUsage } from "./pageAssets.js";
import { BOARD_BRIDGE_JS, BOARD_STALE_CSS } from "./bridge.js";
import { checkFramable } from "./frameCheck.js";
import { parseHtmlEdits, RevisionConflictError } from "./htmlEdit.js";
import { log } from "./log.js";
import { checkPermission, isPermissionValue, permissionViews } from "./pagePermissions.js";
import { PageFileError, deletePageFile, listPageFolder, readPageFile, resolvePageFile, statPageFile, writePageFile, type FileOp } from "./pageFiles.js";
import { frameReach, isAccessLevel, normalizeTarget, pageReach, reachMessage, type PageReader, type Reach } from "./pageAccess.js";
import { clampWaitMs, parseCursor, parseEventNames, parseWhere } from "./signal.js";
import type { StateOp } from "./stateOps.js";
import { locationLabel, matchRecord, qualityLabel } from "./pageSearch.js";
import { chunkPage } from "./search/chunker.js";
import { store, type CleanupBasis, type CleanupOptions, type FolderDeleteMode } from "./store.js";
import { isBlankPage, isPlainObject, toMeta, type BoardEvent, type BoardState, type BuiltinTemplateMeta, type AccessTarget, type Folder, type ImportDestination, type PageActor, type PageEvent, type Tab, type TabMeta, type Template, type TemplateMeta, type UpsertNotice, type Viewer } from "./types.js";
import type { SpacesView } from "./spaces.js";
import { ViewerHub } from "./viewers.js";
import { captureBootOf, captureTab, closeScreenshotBrowser, screenshotHttpStatus, probeTab } from "./screenshot.js";
import { PageProblems, PAGE_PROBLEM_JS, KIT_TONES } from "./pageProblems.js";
import { embedUrlFromHtml } from "./embed.js";

import {
  browserAct,
  browserConsole,
  browserEval,
  browserHttpStatus,
  browserNetwork,
  browserOpen,
  browserScreenshot,
  browserSnapshot,
  browserTabs,
  browserViewport,
  closeAgentBrowser,
  onBrowserChange,
  browserAgentResult,
  browserControl,
  browserHandoffResult,
} from "./browser.js";
import { waitForEvents } from "./wait.js";
import type { ActionCaller } from "./actions/index.js";
import { AgentHost } from "./agent/host.js";
import { worktreePreviewSite } from "./worktreePreview.js";
import { agentRouter } from "./agent/routes.js";
import { readScopedFile } from "./agent/readFile.js";
import { openFileForAgent } from "./agent/openFile.js";
import { searchScopedFiles } from "./agent/searchFiles.js";
import { formatAnswers, parseQuestionInput } from "./agent/questionTool.js";
import { findSettings, parseShowInput, setSettingsCatalog, settingsCatalog } from "./agent/settingsTool.js";
import { parseWebImportance, type WebCall } from "./agent/webAccess.js";
import type { AccessScope } from "./agent/threadAccess.js";
import { BOARD_SCROLLBAR_CSS, inlineKit } from "./wrapHtml.js";
import { spliceHtmlSlot } from "./htmlSlot.js";
import { searchRouter } from "./search/routes.js";
import { mlRouter } from "./ml/routes.js";
import { audioRouter } from "./audio/routes.js";
import { PageAudio } from "./audio/page.js";
import { AudioService } from "./audio/service.js";
import { audioStreamServer } from "./audio/stream.js";
import { shellAssets } from "./shellAssets.js";
import { editorBundle, prebuildEditorBundle } from "./editorBundle.js";
import { appearanceRouter } from "./appearance.js";
import { identify, prepareSecrets, socketAllowed } from "./callers.js";
import { PeerService } from "./devices/peers.js";
import { devicesRouter } from "./devices/routes.js";
import { peerGateway } from "./devices/gateway.js";
import { peerDeviceOf } from "./devices/link.js";
import { PDFJS_PATH, contentOriginGate, framePageId, isContentHost, requestOrigin, requestSuffix } from "./contentOrigin.js";
import { DiskLinkTakenError, FileExistsError, NeedsLocationError } from "./diskFolders.js";
import { browserViewHtml } from "./browserPage.js";
import { FileConflictError, fileViewerHtml, linkedImagePath, listFolder, readFileBytes, readFileForPage, samePath, writeFileText } from "./filePages.js";
import { readPdfText } from "./pdfText.js";
import { searchEmbedder } from "./search/embedder.js";
import { refreshSearchIndex, searchIndex } from "./search/service.js";
import { PluginService } from "./plugins/service.js";
import { PluginActions } from "./plugins/actions.js";
import { pluginRouter } from "./plugins/routes.js";
import { setPlugins, plugins, setPluginActions } from "./plugins/current.js";
import { normalizeTemplateInput } from "./templates.js";
import { declaredPlugins, declarePlugins } from "./plugins/manifest.js";
import { exportTransfer, importTransfer, type PluginExportChoice } from "./plugins/transfer.js";
import { readPackage } from "./plugins/package.js";
import { mainRepository } from "./plugins/git.js";

const publicDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const pageProblems = new PageProblems();

/**
 * Grammars chat fences often use that highlight.js's common bundle leaves out (js, ts, python,
 * rust, go, json, bash, html, … are already in highlight.min.js).
 */
const EXTRA_HIGHLIGHT_LANGUAGES = [
  "apache", "armasm", "awk", "clojure", "cmake", "coffeescript", "crystal", "d", "dart", "delphi",
  "dockerfile", "dos", "elixir", "elm", "erlang", "fortran", "fsharp", "gherkin", "glsl", "gradle",
  "groovy", "handlebars", "haskell", "haxe", "http", "julia", "latex", "lisp", "matlab", "nginx",
  "nim", "nix", "ocaml", "pgsql", "powershell", "properties", "protobuf", "qml", "reasonml", "scala",
  "scheme", "thrift", "twig", "vim", "x86asm",
];
let highlightBundle: string | null = null;

/** highlight.js's common bundle plus the extra grammars, which register themselves on the global hljs. */
function highlightScript(): string {
  const root = path.join(publicDir, "..", "node_modules", "@highlightjs", "cdn-assets");
  const parts = [fs.readFileSync(path.join(root, "highlight.min.js"), "utf8")];
  for (const lang of EXTRA_HIGHLIGHT_LANGUAGES) {
    parts.push(fs.readFileSync(path.join(root, "languages", `${lang}.min.js`), "utf8"));
  }
  return parts.join("\n;\n");
}
const startedAt = Date.now();
const sockets = new Set<WebSocket>();
const viewers = new ViewerHub();
let agentHost: AgentHost | null = null;
let pluginActions: PluginActions | null = null;

function refreshPluginTemplates(): void {
  if (!plugins) return;
  store.setPluginTemplates(plugins.templates().map(({plugin,pluginName,definition,metadata,html,guide}) => {
    const key=`plugin-${plugin}--${definition.key}`;
    const parsed=normalizeTemplateInput({...metadata,html});
    const {pin,...rest}=parsed;
    const actionGuide=Object.entries(definition.actions??{}).map(([name,def])=>`- \`${name}\` ${def.args}: ${def.description}`).join("\n");
    const fullGuide=guide.includes("{{actions}}")?guide.replace("{{actions}}",actionGuide):[guide,actionGuide].filter(Boolean).join("\n\n");
    return {...rest,...(pin===false?{pin:false as const}:{}),plugin:{id:plugin,name:pluginName},id:`builtin:${key}`,key,guide:fullGuide,createdAt:Date.now(),updatedAt:Date.now(),stateVersion:parsed.stateVersion??1};
  }));
}

export function viewerCount(): number {
  return viewers.count();
}

export async function startHttp(): Promise<http.Server> {
  store.load();
  const pluginService = new PluginService(undefined,(id,name,data,registry=false)=> {
    if(registry) refreshPluginTemplates();
    for(const socket of sockets) if(socket.readyState===1) socket.send(JSON.stringify({type:"plugin_event",plugin:id,name,data,registry}));
  },(page,name,mimeType,data)=>store.savePageAsset(page,{name,mimeType,data}).asset);
  setPlugins(pluginService);
  pluginActions=new PluginActions(pluginService,store);
  setPluginActions(pluginActions);
  refreshPluginTemplates();
  prepareSecrets();
  refreshSearchIndex();
  // Watch linked disk folders (#707) once start-up is done: the first scan of each can take a moment.
  setTimeout(() => store.watchDisk(), 3000).unref();
  if (builtinWatchEnabled()) {
    watchBuiltinTemplates(() => {
      const changed = store.reloadBuiltins();
      if (changed.length) {
        log(`reloaded built-in templates: ${changed.join(", ")}`);
      }
    });
  }
  const flush = async () => {
    await pluginService.close();
    store.stopDiskWatch();
    searchEmbedder.stop();
    void searchIndex.close();
    try {
      agentHost?.dispose();
    } catch {
      /* ignore */
    }
    try {
      store.closeDb();
    } catch {
      /* already logged */
    }
  };
  process.once("SIGINT", () => {
    void flush().finally(()=>process.exit(0));
  });
  process.once("SIGTERM", () => {
    void flush().finally(()=>process.exit(0));
  });

  const app = express();
  app.disable("x-powered-by");
  const peerHosts = peerHostsOverride();
  const peers = new PeerService({ home: dataDir(), port: PEER_PORT, hosts: peerHosts === "off" ? [] : peerHosts, version: VERSION, log });
  // Another device's UI through the peer link (#905), on d-<device>.localhost; its files from here when versions match.
  const uiAssets = shellAssets(publicDir, {
    "/vendor/marked.js": path.join(publicDir, "..", "node_modules", "marked", "lib", "marked.umd.js"),
    "/vendor/purify.js": path.join(publicDir, "..", "node_modules", "dompurify", "dist", "purify.min.js"),
    "/vendor/highlight.js": () => highlightBundle ??= highlightScript(),
    "/vendor/editor.js": editorBundle,
    "/vendor/scribe-md.js": path.join(publicDir, "..", "templates", "scribe-md.js"),
  });
  const publicFiles = express.static(publicDir);
  const gateway = peerGateway(peers, { version: VERSION, port: PORT, local: (req, res, next) => uiAssets(req, res, () => publicFiles(req, res, next)) });
  app.use(gateway.http);
  app.use(contentOriginGate);
  // These open a window on this device's own screen: not for someone viewing it from another device.
  app.post(["/api/tabs/:id/file/open-location", "/api/agent/integrations/intellij/open", "/api/search/open-folder"], (req, res, next) => {
    if (identify(req).device) res.status(409).json({ error: "This opens on the device's own screen, so it is not available from another device." });
    else next();
  });
  const pageComponents = new PageComponents(store, pluginService);
  app.use(componentSite(() => agentHost ?? undefined, publicDir, pageComponents));
  // A worktree's UI preview, on its chat's own origin (#703); other hosts go on.
  app.use(worktreePreviewSite(id => agentHost?.getThread(id)?.worktree));
  // The board's own controls (#682): chats, approvals, folders, trash, export. An agent calling them
  // directly could answer its own access request or move a folder into its scope.
  app.use(["/api/agent", "/api/export", "/api/import", "/api/trash", "/api/undo", "/api/library/delete", "/api/library/cleanup", "/api/settings/index", "/api/folders", "/api/ml/settings", "/api/audio/settings"], (req, res, next) => {
    const read = req.method === "GET" && (req.baseUrl === "/api/folders" || req.baseUrl.endsWith("/settings"));
    if (read || viewerOf(req) !== "agent") {
      next();
      return;
    }
    res.status(403).json({ error: "Only the board UI can do this" });
  });
  app.use(uiAssets);
  agentHost = new AgentHost((event) => {
    broadcast(event);
    // Fresh model output replaces a claimed card's launch status promptly.
    if (event.type === "agent_delta" || (event.type === "agent_item" && event.item.kind === "tool")) {
      scheduleSweep(1000);
    }
    // A turn that ends may leave a claimed card behind; check soon rather than at the next tick.
    if (event.type === "agent_turn" && event.turn.status !== "running") {
      scheduleSweep(2000);
    }
    // A thread that starts or stops waiting on the user blocks or frees the card it holds.
    if (event.type === "agent_thread" && (event.thread.status === "waiting") !== waitingThreads.has(event.thread.id)) {
      if (event.thread.status === "waiting") waitingThreads.add(event.thread.id);
      else waitingThreads.delete(event.thread.id);
      scheduleSweep(1000);
    }
    if (event.type === "agent_thread_deleted") waitingThreads.delete(event.id);
    // A page's run ended (merged, or out of usage for good): its worker goes on to the next card.
    if (event.type === "agent_thread" && event.thread.run?.phase === "ended") scheduleSweep(500);
  });
  const sweepTimer = setInterval(() => scheduleSweep(0), 60_000);
  sweepTimer.unref?.();
  scheduleSweep(5000);
  app.use("/api/agent", agentRouter(agentHost));
  try{
    const folder=path.join(INSTALL_ROOT,"plugins","builtin","git-history");
    if(fs.existsSync(folder)){
      const files=readPackage(folder);pluginService.registerBundled(files);
      if(!pluginService.database.removed("git-history")&&!pluginService.database.list().some(p=>p.manifest.id==="git-history")){
        await pluginService.install(files,pluginService.preview(files).hash);
        const repositories=[...new Set((await Promise.all([...agentHost.workspaceFolders().values()].map(folder=>mainRepository(folder)))).filter((folder):folder is string=>!!folder))];
        await pluginService.configure("git-history",{repositories});
      }
    }
  }catch(error){log("Bundled Git history plugin could not be loaded",String(error));}
  pluginService.startKeptAlive();
  onBrowserChange((view, threadId) => broadcast({ type: "agent_browser", threadId, view }));
  app.use("/api/plugins",express.json({limit:"90mb"}));
  app.use(express.json({ limit: "6mb" }));
  app.use("/api/plugins",pluginRouter(pluginService,store,agentHost));
  app.use("/api/appearance", appearanceRouter({ read: () => store.readAppearance(), write: settings => store.writeAppearance(settings) }, (settings, revision) => broadcast({ type: "appearance", settings, revision })));
  app.use("/api/search", searchRouter(undefined, reachable));
  app.use("/api/ml", mlRouter(undefined, { grants: (id) => store.pagePermissions(id) }));
  let devicesQueued = false;
  peers.on("change", () => {
    // Heartbeats and several links coming up at once fold into one refetch.
    if (devicesQueued) return;
    devicesQueued = true;
    setTimeout(() => { devicesQueued = false; broadcast({ type: "devices" }); }, 250).unref();
  });
  peers.on("paired", (result) => broadcast({ type: "device_paired", ...result }));
  app.use("/api/devices", devicesRouter(peers));
  const audioService = new AudioService({ sources: () => agentHost?.modelSources() ?? [] });
  const pageAudio = new PageAudio(id => store.pagePermissions(id));
  const audioStream = audioStreamServer(() => audioService.streamTarget(), (bytes, ok) => audioService.recordUsage(bytes, ok), tab => pageAudio.check(tab));
  app.use("/api/audio", audioRouter(audioService, pageAudio));
  app.use(noteAgentSession);
  app.use(publicFiles);
  // pdf.js for PDF file pages: the library, its worker, and the fonts, CMaps and decoders it fetches.
  app.use("/vendor/pdfjs", (req, res, next) => (PDFJS_PATH.test(req.path) ? next() : res.status(404).end()),
    express.static(path.join(publicDir, "..", "node_modules", "pdfjs-dist"), { fallthrough: false, index: false }));

  app.param("id", (req, res, next, id: string) => {
    if (req.path.startsWith("/api/templates/") || req.path.startsWith("/api/folders/")) {
      next();
      return;
    }
    // An agent's page access (#269): out of reach answers like a missing page, or says to ask.
    // It covers Restricted (agentHidden) too: a chat on that page, or one the user @mentioned it in, gets in.
    const tab = store.get(id);
    if (tab && !checkReach(req, res, tab)) return;
    // A page's script reaches its own page and what that page was granted (#660).
    if (isContentHost(req) && (!tab || !reachedByFrame(req, tab))) {
      res.status(404).json({ error: `tab not found: ${id}` });
      return;
    }
    next();
  });

  app.post("/api/tabs/:id/problems", (req, res) => {
    const tab = store.get(req.params.id);
    // Reports are private to the page's own origin and a random, short-lived render token.
    if (!tab || framePageId(req) !== tab.id) { res.status(404).end(); return; }
    pageProblems.report(tab.id, req.body);
    res.status(204).end();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      root: INSTALL_ROOT,
      url: baseUrl(),
      viewers: viewerCount(),
      tabs: store.list().length,
      closedCount: store.closedCount(),
      activeId: store.getActiveId(),
      uptimeMs: Date.now() - startedAt,
    });
  });

  /** Whether an external link can be shown in a peek or split, or needs the browser. */
  app.get("/api/frame-check", (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    checkFramable(url)
      .then((result) => res.json(result))
      .catch((err: Error) => res.json({ framable: null, reason: err.message }));
  });

  app.get("/api/tabs", (req, res) => {
    const viewer = viewerOf(req);
    const see = reachable(req);
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    const activeId = store.getActiveId(viewer);
    const active = activeId && (!see || see(store.get(activeId)!)) ? activeId : null;
    if (query) {
      const result = store.searchOpen(query, viewer, see);
      const outside = outsideTitles(req, store.listOpenTabs(viewer), query);
      res.json({
        tabs: result.hits.map((hit) => ({ ...libraryMeta(hit.tab), snippet: hit.snippet })),
        returned: result.returned,
        remaining: result.remaining,
        matchCount: result.matchCount,
        openCount: result.total,
        activeId: active,
        closedCount: store.closedCount(viewer, see),
        ...(outside.length ? { outside } : {}),
      });
      return;
    }
    const outside = outsideTitles(req, store.listOpenTabs(viewer), "", 50);
    res.json({
      tabs: store.listOpenTabs(viewer, see).map(libraryMeta),
      activeId: active,
      closedCount: store.closedCount(viewer, see),
      ...(outside.length ? { outside } : {}),
    });
  });

  app.get("/api/library", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const offset = optionalNumber(req.query.offset) ?? 0;
    const limit = optionalNumber(req.query.limit) ?? 200;
    const folderPath = typeof req.query.folder === "string" ? req.query.folder.trim() : "";
    let folderId: string | null | undefined;
    if (folderPath) {
      folderId = folderPath === "/" ? null : store.findFolderPath(folderPath);
      if (folderId === undefined) {
        res.status(404).json({ error: `folder not found: ${folderPath}` });
        return;
      }
    }
    const see = reachable(req);
    const result = store.searchLibrary(query, { offset, limit, folderId, viewer: viewerOf(req), see });
    const outside = see && query.trim() && offset === 0 ? outsideTitles(req, store.searchLibrary("", { folderId, viewer: viewerOf(req), limit: Number.MAX_SAFE_INTEGER }).hits.map((hit) => hit.tab), query) : [];
    res.json({
      tabs: result.hits.map((hit) => ({ ...libraryMeta(hit.tab), snippet: hit.snippet })),
      returned: result.returned,
      remaining: result.remaining,
      matchCount: result.matchCount,
      total: result.total,
      ...(outside.length ? { outside } : {}),
    });
  });

  /** A match in a template page's data: the card or item it sits in, for the palette to name and open (#355). */
  const recordHit = (tab: Tab, location: string | null, query: string): { anchor?: string; matchLabel?: string } => {
    const declaration = location === "data" ? store.searchDeclaration(tab) : undefined;
    if (!declaration) {
      return {};
    }
    const record = matchRecord(chunkPage(tab, null, declaration).filter((chunk) => chunk.kind === "record"), query);
    return record ? { anchor: `record=${encodeURIComponent(record.anchor)}`, matchLabel: record.label } : {};
  };

  app.get("/api/search", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const limit = optionalNumber(req.query.limit);
    const result = store.searchPages(query, limit, viewerOf(req), reachable(req));
    res.json({
      tabs: result.hits.map((hit) => ({
        ...libraryMeta(hit.tab),
        ...recordHit(hit.tab, hit.location, query),
        location: hit.location,
        quality: hit.quality,
        locationLabel: hit.location ? locationLabel(hit.location) : null,
        qualityLabel: hit.quality ? qualityLabel(hit.quality, hit.matchedParts, hit.totalParts) : null,
        matchedParts: hit.matchedParts,
        totalParts: hit.totalParts,
        snippet: hit.snippet,
      })),
      returned: result.returned,
      matchCount: result.matchCount,
    });
  });

  app.get("/api/tabs/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    const usage = store.pageAssetUsageOf(tab.id);
    res.json({ ...tab, folder: store.folderPath(tab.folderId), ...(usage.count ? { pageAssets: usage } : {}) });
  });

  app.post("/api/tabs", async (req, res) => {
    try {
      const assets = prepareAssets(parseAssetInputs(req.body?.assets));
      const rawRevision = req.body?.expectedRevision;
      const replyTo = parseReplyTo(req.body?.replyTo);
      // Refuse a bad target before the page is made or replaced.
      const reach = reachFor(req);
      const replyPage = replyTo ? store.get(replyTo.page, "agent") : undefined;
      if (replyTo && (!replyPage || (reach && (reach(replyPage) === "hidden" || reach(replyPage) === "request")))) {
        throw new Error(`replyTo page not found: ${replyTo.page}`);
      }
      // Replacing a page by its key is a write to that page (#269).
      const key = optionalString(req.body?.key);
      const existing = key ? store.get(key, viewerOf(req)) : undefined;
      if (existing && !checkReach(req, res, existing)) return;
      const baseRef = optionalString(req.body?.base);
      let html = String(req.body?.html ?? "");
      if (baseRef) {
        // Same access as GET /api/tabs/:id (page_read): missing or hidden is not found.
        const baseTab = store.get(baseRef);
        if (!baseTab) {
          res.status(404).json({ error: `base page not found: ${baseRef}` });
          return;
        }
        if (!checkReach(req, res, baseTab)) return;
        if (baseTab.file) {
          throw new Error(`${baseTab.key} is a file page (${baseTab.file.path}); page_show base needs an HTML page.`);
        }
        if (baseTab.templateId) {
          throw new Error(`This page (${baseTab.key}) is bound to a template and cannot be used as a page_show base.`);
        }
        html = spliceHtmlSlot(baseTab.html, html);
      }
      html=declarePlugins(html,req.body?.plugins);
      const { tab, created, closed, titleKept } = store.upsert({
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        html,
        activate: req.body?.activate,
        pin: req.body?.pin,
        state: isPlainObject(req.body?.state) ? req.body.state : undefined,
        assets: assets.length ? assets : undefined,
        folder: optionalString(req.body?.folder),
        viewer: viewerOf(req),
        actor: actorOf(req),
        expectedRevision: typeof rawRevision === "number" && Number.isFinite(rawRevision) ? rawRevision : undefined,
        into: threadBlankPage(req),
        homeFits: reach ? homeFits(req, reach) : undefined,
      });
      if (!created) {
        agentRewrote(req, tab.id);
      }
      const shown = replyTo === undefined ? tab : store.setReplyTo(tab.id, replyTo);
      const problems = await collectPageProblems(req, tab);
      res.status(created ? 201 : 200).json({ created, closed, titleKept, tab: libraryMeta(shown), ...(problems.length ? { problems } : {}) });
    } catch (err) {
      res.status(err instanceof RevisionConflictError ? 409 : 400).json({ error: (err as Error).message });
    }
  });

  /** New page (Ctrl+T) in the board UI. id brings back the window's draft after a daemon restart. */
  app.post("/api/drafts", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can open a new page this way" });
      return;
    }
    const tab = store.createDraft(optionalString(req.body?.id));
    res.status(201).json({ tab: { ...toMeta(tab), ...(store.isDraft(tab.id) ? { draft: true } : {}) } });
  });

  app.delete("/api/drafts/:id", (req, res) => {
    res.json({ discarded: store.discardDraft(req.params.id) });
  });

  app.patch("/api/tabs/:id", (req, res) => {
    try {
      const { tab, titleKept } = store.update(req.params.id, {
        title: optionalString(req.body?.title),
        html: optionalString(req.body?.html),
        pin: typeof req.body?.pin === "boolean" ? req.body.pin : undefined,
        activate: req.body?.activate,
        viewer: viewerOf(req),
        actor: actorOf(req),
      });
      if (optionalString(req.body?.html) !== undefined) {
        agentRewrote(req, tab.id);
      }
      res.json({ titleKept, tab: libraryMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/rename", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can rename a page this way" });
      return;
    }
    try {
      const tab = store.renamePage(req.params.id, String(req.body?.title ?? ""));
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/move", (req, res) => {
    try {
      const folderId = parseFolderRef(req.body?.folderId);
      const index = optionalNumber(req.body?.index) ?? 0;
      // The user moving a file page into a folder on disk moves the file too (#707); agents only move the page.
      if (viewerOf(req) !== "agent") {
        store.moveFileWithPage(req.params.id, folderId, { keepBoth: req.body?.keepBoth === true });
      }
      const tab = store.movePage(req.params.id, folderId, index, { close: req.body?.close === true });
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      if (err instanceof FileExistsError) {
        res.status(409).json({ error: err.message, exists: err.target });
        return;
      }
      sendStoreError(res, err);
    }
  });

  app.post("/api/tabs/:id/patch", async (req, res) => {
    try {
      const title = optionalString(req.body?.title);
      const html = typeof req.body?.html === "string" ? req.body.html : undefined;
      const rawRevision = req.body?.expectedRevision;
      const expectedRevision = typeof rawRevision === "number" && Number.isFinite(rawRevision) ? rawRevision : undefined;
      const rawEdits = req.body?.edits;
      const noEdits = rawEdits === undefined || (Array.isArray(rawEdits) && rawEdits.length === 0);
      const replyTo = parseReplyTo(req.body?.replyTo);
      if (replyTo !== undefined) {
        const tab = store.setReplyTo(req.params.id, replyTo);
        if (noEdits && html === undefined && !title) {
          res.json({ applied: 0, closed: store.isClosed(tab.id), tab: libraryMeta(tab) });
          return;
        }
      }
      if (noEdits && html === undefined && title) {
        const { tab, titleKept } = store.update(req.params.id, {
          title,
          activate: req.body?.activate,
          expectedRevision,
          viewer: viewerOf(req),
          actor: actorOf(req),
        });
        res.json({ applied: 0, closed: store.isClosed(tab.id), titleKept, tab: libraryMeta(tab) });
        return;
      }
      const { tab, applied, closed, titleKept } = store.patchHtml(req.params.id, {
        edits: noEdits ? undefined : parseHtmlEdits(rawEdits),
        html,
        title,
        activate: req.body?.activate,
        expectedRevision,
        viewer: viewerOf(req),
        actor: actorOf(req),
      });
      agentRewrote(req, tab.id);
      const problems = await collectPageProblems(req, tab);
      res.json({ applied, closed, titleKept, tab: libraryMeta(tab), ...(problems.length ? { problems } : {}) });
    } catch (err) {
      const message = (err as Error).message;
      const status = message.startsWith("tab not found") ? 404 : err instanceof RevisionConflictError ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  /**
   * The agent guide of the template a page was made from; the MCP hands it to the agent once per
   * session. For a Scribe chat's MCP, deliver=1 also says whether that chat already has it (its
   * prompt may have carried it) and records it as given; force=1 records it without asking.
   */
  app.get("/api/tabs/:id/guide", (req, res) => {
    const tab = store.get(req.params.id, viewerOf(req));
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    const templateGuide = (tab.templateId && store.templateGuide(tab.templateId)) || null;
    const guide=templateGuide;
    const thread = threadOf(req);
    const pluginGuides=declaredPlugins(tab.html).filter(id=>pluginService.enabled(id)).map(id=>{
      const p=pluginService.guide(id),guide={id:`plugin:${p.id}`,title:`Plugin ${p.id}`,text:`${p.summary}\n${p.guide}\n${JSON.stringify({methods:p.methods,components:p.components})}`};
      const sent=thread&&req.query.deliver==="1"?req.query.force!=="1"&&guideSent(thread,guide):undefined;
      if(thread&&req.query.deliver==="1")markGuideSent(thread,guide);return {guide,...(sent===undefined?{}:{sent})};
    });
    if (!guide || !thread || req.query.deliver !== "1") {
      res.json({ guide,pluginGuides });
      return;
    }
    const sent = req.query.force !== "1" && guideSent(thread, guide);
    markGuideSent(thread, guide);
    res.json({ guide, sent,pluginGuides });
  });

  app.get("/api/tabs/:id/state", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    res.json({
      id: tab.id,
      key: tab.key,
      state: tab.state,
      stateRevision: tab.stateRevision,
      stateUpdatedAt: tab.stateUpdatedAt,
      eventCursor: tab.eventSeq,
      ...(tab.templateId
        ? {
            templateId: tab.templateId,
            templateCompatible: tab.templateCompatible !== false,
            templateValues: tab.templateValues ?? {},
            ...(tab.templateIncompatibleReason
              ? { templateIncompatibleReason: tab.templateIncompatibleReason }
              : {}),
          }
        : {}),
    });
  });

  /** Log an event (a page's signal, or an agent's note), after any state ops sent with it. */
  app.post("/api/tabs/:id/events", (req, res) => {
    try {
      const by = !isContentHost(req) && viewerOf(req) === "agent" ? "agent" : "user";
      const { event, tab, write } = store.logEvent(req.params.id, {
        name: String(req.body?.name ?? ""),
        data: req.body?.data,
        by,
        ops: Array.isArray(req.body?.ops) ? req.body.ops : undefined,
        client: optionalString(req.body?.client),
        writeId: optionalString(req.body?.writeId),
        actor: actorOf(req),
      });
      res.json({
        event,
        stateRevision: tab.stateRevision,
        ...(write?.ok ? { fromRevision: write.fromRevision, applied: write.applied, skipped: write.skipped } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/wait", (req, res) => {
    handleWait(req, res, req.body?.events ?? req.body?.names, req.body?.after, req.body?.timeoutMs, req.body?.where);
  });

  app.get("/api/tabs/:id/wait", (req, res) => {
    handleWait(req, res, req.query.events ?? req.query.names, req.query.after, req.query.timeoutMs, req.query.where);
  });

  /**
   * Write state as ops (see stateOps.ts). Pages send lenient writes; agents strict ones. The reply
   * carries the ops that applied, never the whole state: viewers get the same ops as a delta.
   */
  app.put("/api/tabs/:id/state", (req, res) => {
    try {
      const assetFiles = parseAssetInputs(req.body?.assets);
      // Reading local files is for the agent; a page must not be able to pull files off the disk.
      if (assetFiles.length && isContentHost(req)) {
        res.status(403).json({ error: "pages save assets with scribe.saveAsset, not file paths" });
        return;
      }
      if (!Array.isArray(req.body?.ops)) {
        res.status(400).json({ error: "send ops: an array of state ops (see the scribe skill)" });
        return;
      }
      const result = store.writeState(req.params.id, {
        ops: req.body.ops,
        lenient: req.body?.lenient === true,
        ...(assetFiles.length ? { assets: assetFiles } : {}),
        expectedRevision:
          typeof req.body?.expectedRevision === "number" ? req.body.expectedRevision : undefined,
        client: optionalString(req.body?.client),
        writeId: optionalString(req.body?.writeId),
        resolveIncompatibility: req.body?.resolveIncompatibility === true,
        actor: actorOf(req),
        byUser: viewerOf(req) !== "agent",
      });
      if (!result.ok) {
        res.status(409).json({ error: "stale expectedRevision", conflict: true, stateRevision: result.stateRevision });
        return;
      }
      res.json({
        fromRevision: result.fromRevision,
        stateRevision: result.tab.stateRevision,
        applied: result.applied,
        skipped: result.skipped,
        ...(result.assets ? { assets: result.assets.map(assetView), usage: store.pageAssetUsageOf(result.tab.id) } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /**
   * A page's scribe.reply (#320). The board UI posts it once the user's click reached the page's
   * frame; pages cannot call it themselves (content origin) and agents may not (no click). The page's
   * reply target, set by the agent that made it, decides where it goes; a Kanban card's chat gets it
   * like a comment from the board's own box.
   */
  app.post("/api/tabs/:id/reply", async (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the user's click on the page sends a reply" });
      return;
    }
    try {
      const threadInfo = (id: string) => (agentHost ? agentHost.runInfo(id) : ({ exists: false } as const));
      const source=store.get(req.params.id);
      const pluginReply=source?await pluginActions?.reply(source,req.body?.data,req.body?.summary,threadInfo):null;
      const { target, result, deliver } = pluginReply ?? store.receiveReply(req.params.id, { summary: req.body?.summary, data: req.body?.data }, threadInfo);
      let delivered: "steered" | "queued" | "started" | null = null;
      if (deliver && agentHost) {
        const source = store.get(req.params.id);
        try {
          delivered = agentHost.cardMessage(deliver.thread, {
            num: deliver.num,
            board: target.title || "Kanban board",
            boardKey: target.key,
            ...(deliver.title ? { title: deliver.title } : {}),
            ...(deliver.resume ? { resume: true } : {}),
            ...(source ? { reply: source.key } : {}),
          }, deliver.text).delivered;
        } catch (err) {
          log("Reply delivery failed", String(err));
        }
        if(pluginReply)await pluginActions?.replyDelivered(target,deliver,delivered,threadInfo);
        else store.replyDelivered(target.id, deliver, delivered, threadInfo);
      }
      res.json({ ok: true, target: { id: target.id, key: target.key, title: target.title }, delivered, result: result ?? null });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /** Run a template action (see src/actions). Agents through page_action; pages through scribe.action. */
  app.post("/api/tabs/:id/action", async (req, res) => {
    try {
      const tab=store.get(req.params.id);
      const readOnly: boolean | string = (res.locals.readOnlyReach as string | undefined) ?? (req.body?.readOnly===true || (threadOf(req)?agentHost?.getThread(threadOf(req)!)?.approval==="readonly":false));
      const { result, stateRevision } = tab && pluginActions?.binding(tab) ? await pluginActions.action(tab,String(req.body?.action??""),req.body?.args??{},callerOf(req),(id)=>agentHost?agentHost.runInfo(id):{exists:false},readOnly) : store.runAction(req.params.id, String(req.body?.action ?? ""), req.body?.args, callerOf(req), (id) =>
        agentHost ? agentHost.runInfo(id) : { exists: false }, readOnly
      );
      res.json({ result: result ?? null, stateRevision });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  const componentPage = (req: express.Request) => {
    if (viewerOf(req) === "agent" || framePageId(req) !== req.params.id) throw new Error("Components must name their host page.");
  };
  app.post("/api/tabs/:id/components", (req, res) => {
    try { componentPage(req); res.json({ ok: true, ...pageComponents.resolve(req.params.id, req.body ?? {}, host => requestOrigin(req, host), requestSuffix(req)) }); }
    catch (error) { res.json({ ok: false, error: (error as Error).message }); }
  });
  app.post("/api/tabs/:id/components/validate", (req, res) => {
    try { componentPage(req); res.json({ ok: true, ...pageComponents.validate(req.params.id, req.body ?? {}) }); }
    catch (error) { res.json({ ok: false, error: (error as Error).message }); }
  });
  app.post("/api/tabs/:id/components/leases", (req, res) => {
    try { componentPage(req); res.json(pageComponents.renewAll(req.params.id, req.body?.ids)); }
    catch (error) { res.json({ ok: false, error: (error as Error).message }); }
  });
  app.post("/api/tabs/:id/components/:component/plugin", async (req, res) => {
    try { componentPage(req); res.json({ ok: true, result: await pageComponents.action(req.params.id, req.params.component, req.body ?? {}) }); }
    catch (error) { res.json({ ok: false, error: (error as Error).message }); }
  });
  app.delete("/api/tabs/:id/components/:component", (req, res) => {
    try { componentPage(req); pageComponents.release(req.params.id, req.params.component); res.json({ ok: true }); }
    catch (error) { res.status(403).json({ error: (error as Error).message }); }
  });
  app.get("/api/tabs/:id/components/:component/events", (req, res) => {
    try { componentPage(req); pageComponents.events(req.params.id, req.params.component, res); }
    catch (error) { res.status(403).json({ error: (error as Error).message }); }
  });

  app.post("/api/tabs/:id/plugins/:plugin/call", async (req,res)=> {
    try {
      if(viewerOf(req)==="agent")throw new Error("Agents use plugin_call");
      if(isContentHost(req)&&framePageId(req)!==store.get(req.params.id)?.id)throw new Error("Plugin calls must name the calling page");
      const permission=checkPermission(store.pagePermissions(req.params.id),{perm:`plugin.${req.params.plugin}`});
      if(permission!=="allow") {res.json({ok:false,error:permission==="deny"?"denied":"permission",permission:`plugin.${req.params.plugin}`});return;}
      if(!pluginService.enabled(req.params.plugin)){res.json({ok:false,error:"disabled"});return;}
      res.json({ok:true,result:await pluginService.call(req.params.plugin,String(req.body?.method),req.body?.args??{},{kind:"page",page:req.params.id})});
    }catch(error){res.json({ok:false,error:String((error as Error).message)});}
  });
  app.get("/api/tabs/:id/plugins/:plugin/state/:stateKey",(req,res)=> {
    try {
      if(viewerOf(req)==="agent")throw new Error("Agents use plugin_state");
      if(isContentHost(req)&&framePageId(req)!==store.get(req.params.id)?.id)throw new Error("Plugin state must name the calling page");
      const permission=checkPermission(store.pagePermissions(req.params.id),{perm:`plugin.${req.params.plugin}`});
      if(permission!=="allow"){res.json({ok:false,error:permission==="ask"?"permission":"denied"});return;}
      if(!pluginService.enabled(req.params.plugin))throw new Error("disabled");
      res.json({ok:true,...pluginService.database.get(req.params.plugin,req.params.stateKey)});
    }catch(error){res.json({ok:false,error:String((error as Error).message)});}
  });
  app.get("/api/tabs/:id/plugins",(req,res)=> {
    const tab=store.get(req.params.id);if(!tab){res.status(404).json({ok:false,error:"missing"});return;}
    res.json({ok:true,plugins:declaredPlugins(tab.html).map(id=>({id,enabled:pluginService.enabled(id),installed:pluginService.database.list().some(p=>p.manifest.id===id)}))});
  });

  /**
   * scribe.files (#882): the page's own script, on its own origin, in folders the user approved for it.
   * Agents use their own file tools, and another page cannot borrow this page's folders.
   */
  const pageFileRoute = (op: FileOp, fn: (file: string, req: express.Request, res: express.Response) => void) =>
    (req: express.Request, res: express.Response) => {
      try {
        const tab = store.get(req.params.id);
        if (viewerOf(req) === "agent" || !tab || framePageId(req) !== tab.id) {
          res.status(403).json({ ok: false, error: "denied", message: "Only the page's own script uses its files" });
          return;
        }
        fn(resolvePageFile(store.pagePermissions(tab.id), req.query.path, op), req, res);
      } catch (err) {
        const code = err instanceof PageFileError ? err.code : "failed";
        res.status(code === "not_found" ? 404 : code === "permission" || code === "denied" ? 403 : 400)
          .json({ ok: false, error: code, message: (err as Error).message, ...(code === "permission" || code === "denied" ? { permission: "files" } : {}) });
      }
    };
  app.get("/api/tabs/:id/files/read", pageFileRoute("read", (file, _req, res) => {
    res.type("application/octet-stream").send(readPageFile(file, MAX_PAGE_ASSET_BYTES));
  }));
  app.get("/api/tabs/:id/files/stat", pageFileRoute("stat", (file, _req, res) => res.json({ ok: true, path: file, ...statPageFile(file) })));
  app.get("/api/tabs/:id/files/list", pageFileRoute("list", (file, _req, res) => res.json({ ok: true, path: file, entries: listPageFolder(file) })));
  app.post("/api/tabs/:id/files/write", readAssetBody, pageFileRoute("write", (file, req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new PageFileError("invalid_path", "expected the file's bytes as an application/octet-stream body");
    const entry = writePageFile(file, req.body, { append: req.query.append === "1", overwrite: req.query.overwrite !== "0" });
    res.json({ ok: true, path: file, ...entry });
  }));
  app.post("/api/tabs/:id/files/delete", pageFileRoute("delete", (file, _req, res) => {
    deletePageFile(file);
    res.json({ ok: true, path: file });
  }));

  /** Per-viewer page state (scribe.local). Never broadcast and never shown to agents. */
  app.get("/api/tabs/:id/local", (req, res) => {
    const viewer = viewerIdOf(req.query.viewer);
    const tab = store.get(req.params.id);
    if (!tab || !viewer) {
      res.status(tab ? 400 : 404).json({ error: tab ? "viewer is required" : `tab not found: ${req.params.id}` });
      return;
    }
    res.json({ state: store.getLocal(tab.id, viewer) });
  });

  app.put("/api/tabs/:id/local", (req, res) => {
    try {
      const viewer = viewerIdOf(req.query.viewer ?? req.body?.viewer);
      if (!viewer) {
        res.status(400).json({ error: "viewer is required" });
        return;
      }
      store.setLocal(req.params.id, viewer, req.body?.state);
      res.json({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /** Page code saves blobs here (board.saveAsset). The body is the raw bytes; the type rides in a header. */
  app.post("/api/tabs/:id/assets", readAssetBody, (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "expected the asset bytes as an application/octet-stream body" });
        return;
      }
      const result = store.savePageAsset(req.params.id, {
        name: decodeHeader(req.get("x-asset-name")),
        mimeType: req.get("x-asset-type"),
        data: req.body,
      });
      res.status(201).json({ asset: assetView(result.asset), usage: result.usage });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  app.get("/api/tabs/:id/assets", (req, res) => {
    try {
      const result = store.listPageAssets(req.params.id);
      res.json({ assets: result.assets.map(assetView), usage: result.usage });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  /** JSON for agents: metadata always, base64 bytes when the blob is a small raster image. */
  app.get("/api/tabs/:id/assets/:assetId", (req, res) => {
    try {
      const { meta, data } = store.readTabPageAsset(req.params.id, req.params.assetId);
      const skipped = skipInlinePageImage(meta.mimeType, meta.bytes);
      res.json({
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        bytes: meta.bytes,
        url: pageAssetUrl(meta.id),
        ...(skipped ? { skipped } : { data: data.toString("base64") }),
      });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  app.delete("/api/tabs/:id/assets/:assetId", (req, res) => {
    try {
      res.json({ usage: store.deletePageAsset(req.params.id, req.params.assetId) });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  /** Ids are random and never reused, so the bytes behind one never change. */
  app.get("/blob/:assetId", (req, res) => {
    const found = store.readPageAsset(req.params.assetId);
    if (!found) {
      res.status(404).type("text").send("asset not found");
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (found.meta.mimeType !== "application/pdf") {
      // Stored bytes are arbitrary; opened directly they must not run script on the content origin.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    }
    res.type(found.meta.mimeType).send(found.data);
  });

  app.post("/api/tabs/:id/focus", (req, res) => {
    try {
      const tab = store.focus(req.params.id);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tabs/:id/reorder", (req, res) => {
    try {
      const raw = req.body?.before;
      let before: string | null = null;
      if (raw === null || raw === undefined) {
        before = null;
      } else if (typeof raw === "string" && raw.trim()) {
        before = raw.trim();
      } else {
        throw new Error("before must be a tab id or null");
      }
      const tab = store.reorderTab(req.params.id, before);
      const viewer = viewerOf(req);
      res.json({ tab: toMeta(tab), tabs: store.list(viewer), activeId: store.getActiveId(viewer) });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("tab not found");
      res.status(missing ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/screenshot", (req, res) => {
    captureTab({
      idOrKey: req.params.id,
      selector: optionalString(req.body?.selector),
      fullPage: req.body?.fullPage === true,
      width: optionalNumber(req.body?.width),
      height: optionalNumber(req.body?.height),
      local: req.body?.local,
      fromViewer: req.body?.fromViewer === true,
      click: optionalString(req.body?.click),
    })
      .then((shot) => {
        if (!res.writableEnded) {
          res.json(shot);
        }
      })
      .catch((err: Error) => {
        if (res.writableEnded) {
          return;
        }
        res.status(screenshotHttpStatus(err.message)).json({ error: err.message });
      });
  });

  /**
   * The agent browser, for the browser_* MCP tools. Only Scribe chat threads get one: the MCP
   * marks their requests with the thread id, and each thread drives its own browser context.
   */
  const browserOps: Record<string, (threadId: string, body: any) => Promise<unknown>> = {
    open: browserOpen,
    snapshot: browserSnapshot,
    act: browserAct,
    screenshot: browserScreenshot,
    eval: browserEval,
    console: browserConsole,
    network: browserNetwork,
    viewport: browserViewport,
    tabs: browserTabs,
  };
  app.post("/api/browser/control", async (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) { res.status(403).json({ error: "Browser control needs a Scribe chat thread." }); return; }
    const body = isPlainObject(req.body) ? req.body : {};
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const gone = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", gone);
    try {
      if (body.action === "take") {
        await browserControl(thread, "agent");
        res.json({ control: "agent", userActivity: [], ...browserAgentResult(thread) });
      } else if (body.action === "handoff") {
        if (typeof body.message !== "string" || !body.message.trim()) throw new Error("handoff requires message");
        await agentHost.handoffBrowser(thread, body.message, abort.signal);
        const result = await browserHandoffResult(thread);
        if (!res.writableEnded) res.json(result);
      } else throw new Error("action must be take or handoff");
    } catch (err) {
      if (!res.writableEnded) res.status(browserHttpStatus((err as Error).message)).json({ error: (err as Error).message });
    } finally { res.off("close", gone); }
  });
  app.post("/api/browser/:op", (req, res) => {
    const thread = threadOf(req);
    if (!thread) {
      res.status(403).json({ error: "The agent browser is only available in Scribe chat threads." });
      return;
    }
    const op = Object.hasOwn(browserOps, req.params.op) ? browserOps[req.params.op] : undefined;
    if (!op) {
      res.status(404).json({ error: `unknown browser op: ${req.params.op}` });
      return;
    }
    op(thread, isPlainObject(req.body) ? req.body : {})
      .then((result) => {
        if (!res.writableEnded) {
          res.json({ ...(result as object), ...browserAgentResult(thread) });
        }
      })
      .catch((err: Error) => {
        if (!res.writableEnded) {
          // The user-control refusal lists what the user did; other errors keep their first line (Playwright adds call logs).
          res.status(browserHttpStatus(err.message)).json({ error: err.message.startsWith("The user is controlling") ? err.message : err.message.split("\n")[0] });
        }
      });
  });

  /** page_open's file (#655): a file the agent's thread may read, opened as a page for the user. */
  app.post("/api/agent-open-file", async (req, res) => {
    const id = threadOf(req);
    const thread = id && agentHost ? agentHost.getThread(id) : null;
    if (!thread) { res.status(403).json({ error: "Opening a file needs a Scribe chat thread with file access." }); return; }
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      const { tab, created } = await openFileForAgent(thread, store, body);
      res.status(created ? 201 : 200).json({ tab: toMeta(tab), created });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  app.post("/api/read-file", async (req, res) => {
    const id = threadOf(req);
    const thread = id && agentHost ? agentHost.getThread(id) : null;
    if (!thread) { res.status(403).json({ error: "read_file requires a current Scribe chat thread." }); return; }
    try {
      res.json(await readScopedFile(thread, isPlainObject(req.body) ? req.body : {}));
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  /** skill_read (#239): a Scribe skill this thread may use, in every mode. */
  app.post("/api/skill-read", (req, res) => {
    const id = threadOf(req);
    const thread = id && agentHost ? agentHost.getThread(id) : null;
    if (!thread || !agentHost) { res.status(403).json({ error: "skill_read requires a current Scribe chat thread." }); return; }
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      res.json(agentHost.scribeSkills.read(thread, body.name, body.file));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  for (const grep of [false, true]) {
    app.post(grep ? "/api/grep-files" : "/api/list-files", async (req, res) => {
      const id = threadOf(req);
      const thread = id && agentHost ? agentHost.getThread(id) : null;
      if (!thread) { res.status(403).json({ error: "File search requires a current Scribe chat thread." }); return; }
      try { res.json(await searchScopedFiles(thread, isPlainObject(req.body) ? req.body : {}, grep)); }
      catch (err) { res.status(403).json({ error: (err as Error).message }); }
    });
  }

  /** page_ask from a Scribe chat's MCP: the thread's turn shows the page as a question and waits on its submit event. */
  app.post("/api/ask", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "page_ask only works in Scribe chat threads. Use page_wait instead." });
      return;
    }
    const body = isPlainObject(req.body) ? req.body : {};
    let names: string[];
    try {
      names = parseEventNames(body.events ?? "submit");
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const page = typeof body.page === "string" ? body.page : "";
    if (!page) {
      res.status(400).json({ error: "page is required" });
      return;
    }
    const asked = store.get(page, viewerOf(req));
    if (asked && !checkReach(req, res, asked)) return;
    const timeoutMs = clampWaitMs(body.timeoutMs);
    req.setTimeout(timeoutMs + 10_000);
    res.setTimeout(timeoutMs + 10_000);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .askPage(thread, {
        page,
        ...(typeof body.prompt === "string" && body.prompt.trim() ? { prompt: body.prompt.trim() } : {}),
        events: names.length ? names : ["submit"],
        after: parseCursor(body.after),
        timeoutMs,
        signal: abort.signal,
      })
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(err.message.startsWith("tab not found") ? 404 : 400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /** ask_user from a Scribe chat's MCP: Scribe's own question card in the thread's turn, answered in the chat. */
  app.post("/api/question", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "ask_user only works in Scribe chat threads." });
      return;
    }
    let question;
    try {
      question = parseQuestionInput(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .askQuestions(thread, question, abort.signal)
      .then((answer) => {
        if (!res.writableEnded) res.json({ ...("skipped" in answer ? { skipped: true } : { answered: true }), text: formatAnswers(question, answer) });
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message === "aborted" ? "The question was cancelled." : err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  app.post("/api/component", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) { res.status(403).json({ error: "component_show only works in Scribe chat threads." }); return; }
    let input;
    try { input = parseComponentInput(req.body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const gone = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", gone);
    agentHost.showComponent(thread, input, abort.signal)
      .then(result => { if (!res.writableEnded) res.json(result); })
      .catch(error => { if (!res.writableEnded) res.status(400).json({ error: error.message }); })
      .finally(() => res.off("close", gone));
  });

  /** The app window's list of its settings dialogs' sections and rows, for settings_find. */
  app.put("/api/settings/index", (req, res) => {
    res.json({ count: setSettingsCatalog(req.body) });
  });

  /** settings_find from an MCP client: the settings matching q, as text for the model. */
  app.get("/api/settings/find", (req, res) => {
    try {
      res.json({ text: findSettings(req.query.q) });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  /** settings_show from a Scribe chat's MCP: the rows as a card in the thread's turn, to change there. */
  app.post("/api/settings/show", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "settings_show only works in Scribe chat threads." });
      return;
    }
    try {
      const { ids, title } = parseShowInput(req.body);
      agentHost.showSettings(thread, ids, title);
      const byId = new Map(settingsCatalog().map((e) => [e.id, e]));
      const names = ids.map((id) => byId.get(id)?.label ?? id);
      res.json({ text: `Shown in the chat: ${names.join(", ")}. The user can change them there.` });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** harness_docs from a Scribe chat's MCP (#79): how the agent setup works and what is set now. */
  app.get("/api/harness/docs", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "harness_docs only works in Scribe chat threads." });
      return;
    }
    try {
      res.json({ text: agentHost.harnessDocs(thread) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** harness_change from a Scribe chat's MCP (#79): asks the user in the chat, then changes the agent setup. */
  app.post("/api/harness/change", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "harness_change only works in Scribe chat threads." });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .harnessChange(thread, req.body, abort.signal)
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /**
   * A Scribe chat's MCP asks before it runs one of its own tools (gateTools in mcp.ts): the thread's
   * hooks may deny the call or have the user approve it first. Anything that goes wrong lets it run.
   */
  app.post("/api/tool-gate", (req, res) => {
    const thread = threadOf(req);
    const body = isPlainObject(req.body) ? req.body : {};
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 100) : "";
    if (!thread || !agentHost || !tool) {
      res.json({ allowed: true });
      return;
    }
    // An ask waits on the user, as long as it takes.
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .toolGate(thread, { name: tool, tool: "mcp", title: `Scribe: ${tool}`, input: body.input }, abort.signal)
      .catch(() => ({ allowed: true }))
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .finally(() => res.off("close", onClientGone));
  });

  /**
   * A Scribe chat's MCP hands over a tool's result before the agent gets it (scanTools in mcp.ts):
   * the thread's hooks may have a note to put in front of it. Anything that goes wrong returns none.
   */
  app.post("/api/tool-scan", (req, res) => {
    const thread = threadOf(req);
    const body = isPlainObject(req.body) ? req.body : {};
    const tool = typeof body.tool === "string" ? body.tool.slice(0, 100) : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!thread || !agentHost || !tool || !text) {
      res.json({ note: null });
      return;
    }
    agentHost
      .scanResult(thread, { name: tool, tool: "mcp", title: `Scribe: ${tool}`, text })
      .catch(() => null)
      .then((note) => {
        if (!res.writableEnded) res.json({ note });
      });
  });

  /** web_request from a Scribe chat's MCP: ask the user for a web call the thread's web setting does not cover. */
  app.post("/api/web-request", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "web_request only works in Scribe chat threads." });
      return;
    }
    const body = isPlainObject(req.body) ? req.body : {};
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const domains = Array.isArray(body.domains) ? body.domains.filter((d): d is string => typeof d === "string") : [];
    if (url && !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "url must be an absolute http(s) URL" });
      return;
    }
    const call: WebCall = url ? { kind: "fetch", url } : { kind: "search", ...(typeof body.query === "string" && body.query.trim() ? { query: body.query.trim().slice(0, 300) } : {}), domains };
    const importance = parseWebImportance(body.importance);
    if (body.importance !== undefined && !importance) {
      res.status(400).json({ error: "importance must be necessary, important, useful or trivial" });
      return;
    }
    // necessary can wait for hours; the MCP side keeps the request open as long as it takes.
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .preRequestWeb(thread, call, { importance, ...(typeof body.reason === "string" ? { reason: body.reason.slice(0, 1000) } : {}), signal: abort.signal })
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /** page_access from a Scribe chat's MCP (#269): ask the user for a page outside the chat's access; waits for the answer. */
  app.post("/api/page-access", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "page_access only works in Scribe chat threads." });
      return;
    }
    const body = isPlainObject(req.body) ? req.body : {};
    const page = typeof body.page === "string" ? body.page.trim() : "";
    if (!page) {
      res.status(400).json({ error: "page is required: the page's key or id" });
      return;
    }
    const importance = parseWebImportance(body.importance);
    if (body.importance !== undefined && !importance) {
      res.status(400).json({ error: "importance must be necessary, important, useful or trivial" });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .requestPageAccess(thread, { page, folder: body.folder === true, importance, ...(typeof body.reason === "string" ? { reason: body.reason.slice(0, 1000) } : {}), signal: abort.signal })
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /** thread_update from a Scribe chat's MCP: the chat renames its thread or asks to move its workspace (#577). */
  app.post("/api/thread-update", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "thread_update only works in Scribe chat threads." });
      return;
    }
    const body = isPlainObject(req.body) ? req.body : {};
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    // The workspace change waits for the user's answer.
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    agentHost
      .threadUpdateOp(thread, { title: str(body.title, 500), workspace: str(body.workspace, 2000), reason: str(body.reason, 1000), continue: body.continue !== false, signal: abort.signal })
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /**
   * thread_access, thread_list and thread_read from a Scribe chat's MCP: read other threads in the
   * chat's scopes. Any of them can ask the user first, so the request stays open until answered.
   */
  app.post("/api/thread-access/:op", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "Reading other threads only works in Scribe chat threads." });
      return;
    }
    const host = agentHost;
    const body = isPlainObject(req.body) ? req.body : {};
    const importance = parseWebImportance(body.importance);
    if (body.importance !== undefined && !importance) {
      res.status(400).json({ error: "importance must be necessary, important, useful or trivial" });
      return;
    }
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    const op = req.params.op;
    const run = (): Promise<unknown> => {
      if (op === "request") {
        const only = strings(body.scopes)?.filter((s): s is AccessScope["kind"] => ["workspace", "page", "folder", "search", "all"].includes(s));
        return host.requestThreadAccess(thread, { only, thread: str(body.thread, 60), importance, reason: str(body.reason, 1000), signal: abort.signal });
      }
      if (op === "list") {
        return host.listReadableThreads(thread, {
          q: str(body.q, 300),
          limit: num(body.limit),
          archived: body.archived === true,
          everywhere: body.everywhere === true,
          messages: body.messages === true,
          details: body.details === true,
          importance,
          signal: abort.signal,
        });
      }
      if (op === "read") {
        const target = str(body.thread, 60);
        if (!target) return Promise.reject(new Error("thread is required"));
        return host.readOtherThread(thread, { thread: target, from: num(body.from), limit: num(body.limit), q: str(body.q, 300), kinds: strings(body.kinds), full: body.full === true, importance, signal: abort.signal });
      }
      return Promise.reject(new Error(`unknown op: ${op}`));
    };
    run()
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  /** memory_list, memory_save and memory_delete from a Scribe chat's MCP: the memories agents share (#104). */
  app.post("/api/memory/:op", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "Memory only works in Scribe chat threads." });
      return;
    }
    try {
      res.json(agentHost.memoryOp(thread, req.params.op, isPlainObject(req.body) ? req.body : {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * agent_run and agent_models from a Scribe chat's MCP: hand a task to a helper agent on another
   * provider or model. run stays open until the helper's turn ends; closing it stops the helper.
   */
  app.post("/api/helper/:op", (req, res) => {
    const thread = threadOf(req);
    if (!thread || !agentHost) {
      res.status(403).json({ error: "Helper agents only work in Scribe chat threads." });
      return;
    }
    const host = agentHost;
    const body = isPlainObject(req.body) ? req.body : {};
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    req.setTimeout(0);
    res.setTimeout(0);
    const abort = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);
    const op = req.params.op;
    const run = (): Promise<unknown> => {
      if (op === "models") return host.helperModels(thread, str(body.provider, 40));
      if (op === "run") {
        return host.runHelper(thread, {
          title: str(body.title, 200),
          task: typeof body.task === "string" ? body.task : "",
          provider: str(body.provider, 40),
          model: str(body.model, 200),
          effort: str(body.effort, 40),
          // access is the rung (#719); mode is the older name, with mode values too.
          mode: (body.access ?? body.mode) === undefined ? undefined : typeof (body.access ?? body.mode) === "string" ? String(body.access ?? body.mode) : "invalid",
          thread: str(body.thread, 60),
          background: body.background === true,
          stop: body.stop === true,
          signal: abort.signal,
        });
      }
      return Promise.reject(new Error(`unknown op: ${op}`));
    };
    run()
      .then((result) => {
        if (!res.writableEnded) res.json(result);
      })
      .catch((err: Error) => {
        if (!res.writableEnded) res.status(400).json({ error: err.message });
      })
      .finally(() => res.off("close", onClientGone));
  });

  app.post("/api/undo", (_req, res) => {
    try {
      const { tab } = store.restoreLast();
      res.json({ tab: tab ? toMeta(tab) : null });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "nothing to restore" ? 404 : 400).json({ error: message });
    }
  });

  /** Spaces belong to the user: the board UI manages them, agents only see the strip. */
  const spaceRoute =
    (run: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
      if (viewerOf(req) === "agent") {
        res.status(403).json({ error: "Only the board UI can change spaces" });
        return;
      }
      try {
        store.noteFocus(req.body?.focused);
        run(req);
        res.json(store.spacesView());
      } catch (err) {
        const message = (err as Error).message;
        res.status(/not found|no deleted/.test(message) ? 404 : 400).json({ error: message });
      }
    };

  app.get("/api/spaces", (_req, res) => res.json(store.spacesView()));
  app.post("/api/spaces", spaceRoute((req) =>
    store.createSpace({
      name: req.body?.name,
      color: req.body?.color,
      copyTabs: req.body?.copyTabs === true,
      activate: req.body?.activate === true,
    })
  ));
  app.post("/api/spaces/ensure", spaceRoute(() => store.ensureSpaces()));
  app.post("/api/spaces/cycle", spaceRoute((req) => store.cycleSpace(Number(req.body?.step) || 1)));
  app.post("/api/spaces/restore", spaceRoute((req) =>
    store.restoreSpace(typeof req.body?.id === "string" ? req.body.id : undefined)
  ));
  app.patch("/api/spaces/:sid", spaceRoute((req) =>
    store.updateSpace(req.params.sid, { name: req.body?.name, color: req.body?.color, home: req.body?.home, lens: req.body?.lens })
  ));
  app.post("/api/spaces/:sid/switch", spaceRoute((req) => store.switchSpace(req.params.sid)));
  app.post("/api/spaces/:sid/move", spaceRoute((req) => store.moveSpace(req.params.sid, Number(req.body?.index))));
  app.delete("/api/spaces/:sid", spaceRoute((req) => store.deleteSpace(req.params.sid)));

  app.post("/api/tabs/:id/open", (req, res) => {
    try {
      const rawBefore = req.body?.before;
      const before = rawBefore === null ? null : typeof rawBefore === "string" && rawBefore.trim() ? rawBefore.trim() : undefined;
      const activate = req.body?.activate !== false;
      const tab = store.openPage(req.params.id, { activate, before });
      const threadId = actorOf(req)?.thread;
      if (activate && threadId) {
        agentHost?.followToPage(threadId, tab.id);
        requestAgentFocus(tab.id, threadId);
      }
      res.json({ tab: libraryMeta(tab), closedCount: store.closedCount(viewerOf(req), reachable(req)) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Close/delete results list ids this call affected. Do not include closedCount
  // (Library-wide closed pages): agents read it as "this call closed N tabs".
  app.post("/api/library/delete", async (req, res) => {
    if (refuseAgent(req, res)) return;
    const { pages = [], folders = [], recycle = [] } = req.body || {};
    if (![pages, folders, recycle].every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))) {
      res.status(400).json({ error: "pages, folders and recycle must be lists of ids" });
      return;
    }
    try {
      // Validate the whole selection before touching a file or changing the Library.
      const knownFolders = new Set(store.listFolders().map((folder) => folder.id));
      if (folders.some((id: string) => !knownFolders.has(id))) throw new Error("folder not found");
      const tabs = pages.map((id: string) => {
        const tab = store.get(id);
        if (!tab) throw new Error(`tab not found: ${id}`);
        return tab;
      });
      const deleted = store.deleteMany(tabs.map((tab: Tab) => tab.id), folders, { parkFiles: recycle });
      res.json({ deleted: deleted.map((tab) => tab.id) });
    } catch (err) { sendStoreError(res, err); }
  });

  app.delete("/api/tabs/:id", async (req, res) => {
    try {
      const permanent = req.query.permanent === "true" || req.query.permanent === "1";
      if (permanent) {
        // file=trash: retain the disk file with the page in Scribe Trash, so Undo restores both.
        const file = req.query.file === "trash" && viewerOf(req) !== "agent" ? store.get(req.params.id)?.file : undefined;
        const tab = store.deletePermanent(req.params.id, { parkFiles: file && !file.copy ? [req.params.id] : [] });
        res.json({ deleted: [tab.id] });
        return;
      }
      const tab = store.closeTab(req.params.id);
      if (store.isClosed(tab.id)) {
        res.json({ closed: [tab.id] });
        return;
      }
      res.json({ deleted: [tab.id] });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tabs", (req, res) => {
    const viewer = viewerOf(req);
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    const filter = req.query.filter === "all" ? "all" : "unpinned";
    if (permanent) {
      const ids = store.list(viewer).filter((tab) => filter === "all" || !tab.pinned).map((tab) => tab.id);
      const deleted = store.deleteMany(ids).map((tab) => tab.id);
      res.json({ deleted });
      return;
    }
    const closed = store.closeMany(filter, viewer);
    res.json({ closed });
  });

  app.get("/api/folders", (_req, res) => {
    res.json({ folders: store.listFolders() });
  });

  app.get("/api/folders/tree", (req, res) => {
    // Where a page this caller shows without a folder goes (#260): its chat's space home, else the active one's.
    const thread = viewerOf(req) === "agent" ? threadOf(req) : undefined;
    const space = (thread && agentHost ? agentHost.getThread(thread)?.space : undefined) ?? store.activeSpaceId();
    const home = store.spaceHome(space);
    res.json({ folders: store.folderTree(viewerOf(req), reachable(req)), ...(home ? { newPages: store.folderPath(home) } : {}) });
  });

  app.post("/api/folders", (req, res) => {
    try {
      const folder = store.createFolder({
        name: String(req.body?.name ?? ""),
        parentId: parseFolderRef(req.body?.parentId),
        index: optionalNumber(req.body?.index),
      });
      res.status(201).json({ folder });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.patch("/api/folders/:fid", (req, res) => {
    try {
      res.json({ folder: store.renameFolder(req.params.fid, String(req.body?.name ?? "")) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/move", (req, res) => {
    try {
      const folder = store.moveFolder(
        req.params.fid,
        parseFolderRef(req.body?.parentId),
        optionalNumber(req.body?.index) ?? 0
      );
      res.json({ folder });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.delete("/api/folders/:fid", (req, res) => {
    try {
      const mode: FolderDeleteMode = req.query.mode === "delete" ? "delete" : "lift";
      const { deleted, moved } = store.deleteFolder(req.params.fid, mode);
      res.json({ deleted: deleted.map((tab) => tab.id), moved: moved.map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  /** Link a Library folder to a disk folder (#707), or unlink it with path null. */
  app.put("/api/folders/:fid/disk", (req, res) => {
    try {
      const raw = req.body?.path;
      const dir = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      res.json({ folder: store.setFolderDisk(req.params.fid, dir) });
    } catch (err) {
      if (err instanceof DiskLinkTakenError) {
        res.status(409).json({ error: err.message, folderId: err.folderId });
        return;
      }
      sendStoreError(res, err);
    }
  });

  /** Pages for files in the folder's disk location that have none yet. */
  app.post("/api/folders/:fid/rescan", (req, res) => {
    try {
      res.json({ added: store.rescanFolder(req.params.fid) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/open", (req, res) => {
    try {
      res.json({ opened: store.openFolder(req.params.fid).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/close", (req, res) => {
    try {
      res.json({ closed: store.closeFolder(req.params.fid).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.get("/api/trash", (req, res) => {
    res.json({ batches: store.listTrash(viewerOf(req)) });
  });

  app.post("/api/trash/:id/restore", (req, res) => {
    try {
      const { tabs, folders } = store.restoreFromTrash(req.params.id);
      res.json({ restored: tabs.map((tab) => tab.id), folders: folders.map((folder) => folder.id) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/trash/:id", (req, res) => {
    try {
      res.json({ purged: store.purgeFromTrash(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/trash", (_req, res) => {
    try { res.json({ purged: store.emptyTrash() }); }
    catch (err) { sendStoreError(res, err); }
  });

  /** Library "Clean up tabs": `dryRun` lists what would go; otherwise deletes it as one undoable batch. */
  app.post("/api/library/cleanup", (req, res) => {
    try {
      const opts: CleanupOptions = {
        days: optionalNumber(req.body?.days) ?? 30,
        basis: (optionalString(req.body?.basis) as CleanupBasis | undefined) ?? "activity",
        includeOpen: req.body?.includeOpen === true,
        includePinned: req.body?.includePinned === true,
      };
      if (req.body?.dryRun === true) {
        const pages = store.cleanupCandidates(opts);
        res.json({ pages: pages.map((tab) => ({ id: tab.id, title: tab.title, pinned: tab.pinned, open: tab.closedAt === undefined })) });
        return;
      }
      res.json({ deleted: store.cleanup(opts).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  /** A website as a temporary embed page (#403, #655), for a site link opened in a split. */
  app.post("/api/temp-pages/url", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const { tab, created } = store.openTempUrl(url, { activate: req.body?.activate === true });
      res.status(created ? 201 : 200).json({ tab: toMeta(tab), created });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  /** Keep in Library: a temporary page becomes a page like any other (#655). */
  app.post("/api/tabs/:id/keep", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      res.json({ tab: toMeta(store.keepPage(req.params.id)) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/tabs/:id/agent-hidden", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can change whether the agent sees a tab" });
      return;
    }
    if (typeof req.body?.hidden !== "boolean") {
      res.status(400).json({ error: "hidden must be true or false" });
      return;
    }
    try {
      const tab = store.setAgentHidden(req.params.id, req.body.hidden);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /**
   * A page's or folder's agent access (#269): its level, and grants to remove. Board UI only; the
   * Restricted level is the page's agentHidden flag.
   */
  for (const kind of ["page", "folder"] as const) {
    app.put(kind === "page" ? "/api/tabs/:id/access" : "/api/folders/:fid/access", (req, res) => {
      if (viewerOf(req) === "agent") {
        res.status(403).json({ error: "Only the board UI can change agent access" });
        return;
      }
      const level = req.body?.level;
      const remove = Array.isArray(req.body?.removeGrants) ? req.body.removeGrants.map(normalizeTarget).filter((t: AccessTarget | undefined): t is AccessTarget => Boolean(t)) : [];
      if (level !== undefined && !isAccessLevel(level)) {
        res.status(400).json({ error: "level must be public, open, ask, trusted or restricted" });
        return;
      }
      try {
        const params = req.params as Record<string, string>;
        const id = kind === "page" ? params.id : params.fid;
        if (level !== undefined) {
          if (kind === "page") store.setPageAccessLevel(id, level);
          else store.setFolderAccessLevel(id, level);
        }
        if (remove.length) store.changeAccessGrants({ kind, id: kind === "page" ? store.get(id)?.id ?? id : id }, { remove });
        res.json(kind === "page" ? { tab: toMeta(store.get(id)!) } : { folder: store.listFolders().find((f) => f.id === id) });
      } catch (err) {
        sendStoreError(res, err);
      }
    });
  }

  app.post("/api/tabs/:id/workspace", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can change a page's workspace" });
      return;
    }
    const workspace = req.body?.workspace;
    if (workspace !== null && typeof workspace !== "string") {
      res.status(400).json({ error: "workspace must be a folder path or null" });
      return;
    }
    try {
      const tab = store.setWorkspace(req.params.id, workspace);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.put("/api/folders/:fid/instructions", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can change folder instructions" });
      return;
    }
    if (typeof req.body?.description !== "string" || typeof req.body?.instructions !== "string") {
      res.status(400).json({ error: "description and instructions must be text" });
      return;
    }
    try {
      const folder = store.setFolderInstructions(req.params.fid, req.body.description, req.body.instructions);
      res.json({ folder });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  // Page permissions are the user's: agents can neither read nor change them, and tab pages
  // can't reach these routes (contentOriginGate). The board UI asks and checks for the page.
  app.get("/api/tabs/:id/permissions", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can read page permissions" });
      return;
    }
    try {
      res.json({ permissions: permissionViews(store.pagePermissions(req.params.id)) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tabs/:id/permissions/check", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can check page permissions" });
      return;
    }
    try {
      const grants = store.pagePermissions(req.params.id);
      const need = { perm: String(req.body?.perm ?? ""), folder: optionalString(req.body?.folder), approval: optionalString(req.body?.approval) };
      res.json({ result: checkPermission(grants, need) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.put("/api/tabs/:id/permissions", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can change page permissions" });
      return;
    }
    const value = req.body?.value;
    if (!isPermissionValue(value)) {
      res.status(400).json({ error: "value must be allow, deny, or ask" });
      return;
    }
    try {
      const keep = typeof req.body?.keep === "boolean" ? req.body.keep : undefined;
      const grants = store.setPagePermission(req.params.id, String(req.body?.perm ?? ""), value, req.body?.folders, keep);
      broadcast({ type: "page_permission", id: req.params.id, perm: String(req.body?.perm ?? ""), value });
      res.json({ permissions: permissionViews(grants) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/templates", (req, res) => {
    res.json({ templates: store.listTemplates(viewerOf(req)), builtins: store.listBuiltinTemplates() });
  });

  app.get("/api/templates/:id", (req, res) => {
    const found = store.findTemplate(req.params.id);
    if (!found) {
      res.status(404).json({ error: `template not found: ${req.params.id}` });
      return;
    }
    const { template, builtIn } = found;
    const meta = builtIn
      ? store.listBuiltinTemplates().find((item) => item.id === template.id)
      : store.templateMeta(template, instanceCount(template, viewerOf(req)));
    const guide = store.templateGuide(template.id);
    res.json({
      template: {
        ...meta,
        html: template.html,
        ...(template.initialState ? { initialState: template.initialState } : {}),
        ...(guide ? { guide: guide.text } : {}),
      },
    });
  });

  app.post("/api/templates/:id/copy", (req, res) => {
    try {
      const { template, created } = store.copyBuiltinTemplate(req.params.id);
      res.status(created ? 201 : 200).json({ created, template: store.templateMeta(template, instanceCount(template, viewerOf(req))) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/templates", (req, res) => {
    try {
      const { template, created } = store.upsertTemplate({
        id: optionalString(req.body?.id),
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        description: optionalString(req.body?.description),
        html: String(req.body?.html ?? ""),
        fields: req.body?.fields,
        titleTemplate: optionalString(req.body?.titleTemplate),
        initialState: isPlainObject(req.body?.initialState) ? req.body.initialState : undefined,
        stateVersion: typeof req.body?.stateVersion === "number" ? req.body.stateVersion : undefined,
        guide: typeof req.body?.guide === "string" ? req.body.guide : undefined,
        agentActions: req.body?.agentActions,
        search: req.body?.search,
        pin: typeof req.body?.pin === "boolean" ? req.body.pin : undefined,
        syncedWithBuiltin: req.body?.syncedWithBuiltin === true,
      });
      if (!created && viewerOf(req) === "agent") {
        store.resetTemplatePermissions(template.id);
      }
      res.status(created ? 201 : 200).json({
        created,
        template: {
          ...store.templateMeta(template, instanceCount(template, viewerOf(req))),
          html: template.html,
          ...(template.initialState ? { initialState: template.initialState } : {}),
        },
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/templates/:id", (req, res) => {
    try {
      const template = store.deleteTemplate(req.params.id);
      res.json({ deleted: template.id, key: template.key });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("template not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/templates/:id/open", async (req, res) => {
    try {
      const activate = req.body?.activate !== false;
      const into = viewerOf(req) === "user" ? optionalString(req.body?.into) : activate ? threadBlankPage(req) : undefined;
      const { tab, template, copiedBuiltin } = store.openFromTemplate(req.params.id, req.body?.values ?? {}, {
        activate,
        agentHidden: viewerOf(req) === "user" && req.body?.agentHidden === true,
        actor: actorOf(req),
        into,
        pluginSeed: await pluginActions?.seed(req.params.id,req.body?.values??{}),
      });
      res.status(201).json({ tab: toMeta(tab), template: { id: template.id, key: template.key }, copiedBuiltin });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("template not found");
      res.status(missing ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/template-values", (req, res) => {
    try {
      const tab = store.setTemplateValues(req.params.id, req.body?.values ?? {}, actorOf(req));
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("tab not found") || message.startsWith("template not found");
      res.status(missing ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/template-incompatible", (req, res) => {
    try {
      const tab = store.reportIncompatible(req.params.id, optionalString(req.body?.reason));
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/view/:id/asset/:name", (req, res) => {
    const tab = store.get(req.params.id);
    const name = req.params.name;
    const meta = tab?.assets.find((asset) => asset.name === name);
    const file = tab && meta && isSafeAssetName(name) ? readStoredAsset(tab.id, name) : undefined;
    if (!tab || !meta || !file) {
      res.status(404).type("text").send("asset not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.type(meta.mimeType).send(file);
  });

  app.get("/view/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).type("html").send("<!DOCTYPE html><title>Missing</title><p>Tab not found.</p>");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const capture = captureBootOf(req.query.shot);
    res.type("html").send(injectBoardRuntime(tab, capture ? null : viewerIdOf(req.query.viewer), capture?.local));
  });

  app.get("/download/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    const filename = `${safeFilename(tab.title)}.html`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("html").send(inlineKit(tab.html, (file) => fs.readFileSync(path.join(publicDir, file), "utf8")));
  });

  const sendExport=async(req:express.Request,res:express.Response,file:ReturnType<typeof store.exportFile>,filename:string)=>{
    const dependencies=[...new Set([...file.pages,...file.templates].flatMap(page=>declaredPlugins(page.html)))];
    if(req.query.preview==="1"){res.json({plugins:dependencies.map(id=>{try{return {id,name:pluginService.get(id).manifest.name,version:pluginService.get(id).manifest.version};}catch{return {id,name:id,version:"missing"};}})});return;}
    const choices=typeof req.query.plugins==="string"?JSON.parse(req.query.plugins) as Record<string,PluginExportChoice>:{};
    res.attachment(filename.replace(/\.(json|scribe\.json)$/,".scribe.zip")).type("application/zip").send(await exportTransfer(file,pluginService,choices));
  };
  app.get("/api/export/folder/:fid", async (req, res) => {
    try {
      const file = store.exportFile({ folderId: req.params.fid });
      const name = store.folderPath(req.params.fid) ?? "folder";
      await sendExport(req,res,file,exportFilename(name.replaceAll("/", " - ")));
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.get("/api/export/template/:id", async (req, res) => {
    try {
      const file = store.exportFile({ templateId: req.params.id });
      await sendExport(req,res,file,exportFilename(file.templates[0].title));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("template not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/export/:id", async (req, res) => {
    try {
      const file = store.exportFile({ id: req.params.id });
      const title = file.pages[0]?.title ?? "page";
      await sendExport(req,res,file,exportFilename(title));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/export", async (req, res) => {
    try {
      const ids = (value: unknown): string[] => {
        const values = Array.isArray(value) ? value : [value];
        if (values.some((id) => typeof id !== "string" || !id)) throw new Error("export ids must be nonempty strings");
        return values as string[];
      };
      const selection = req.query.page !== undefined || req.query.folder !== undefined;
      const file = store.exportFile(selection ? {
        pageIds: req.query.page === undefined ? [] : ids(req.query.page),
        folderIds: req.query.folder === undefined ? [] : ids(req.query.folder),
      } : {});
      await sendExport(req,res,file,exportAllFilename(file.exportedAt));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "nothing to export" ? 404 : 400).json({ error: message });
    }
  });

  // ---------- file pages (#654) ----------
  // Only the board opens files by path. Agents can read an existing page's file through page access
  // (#699). A page asks the board (scribe.file), which calls these for the page's own file (Tab.file),
  // never a path the page names. The content origin cannot reach /api (contentOriginGate).

  /** Files and folders in a folder, for Open file / Open folder / Save as. No path: the drives (Windows) or /. */
  app.get("/api/files/list", (req, res) => {
    if (refuseAgent(req, res)) return;
    const raw = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!raw && process.platform === "win32") {
      const drives = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => fs.existsSync(d));
      res.json({ path: "", parent: null, dirs: drives.map((d) => ({ name: d, path: d })), files: [], exists: true });
      return;
    }
    res.json(listFolder(raw || "/"));
  });

  app.post("/api/files/open", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      const file = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      if (!file) throw new Error("path is required");
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`file not found: ${resolved}`);
      const { tab, created } = store.openFilePage({
        path: resolved,
        folderId: parseFolderRef(req.body?.folderId),
        activate: req.body?.activate !== false,
        temp: req.body?.temp === true,
      });
      res.status(created ? 201 : 200).json({ tab: toMeta(tab), created });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/files/open-folder", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      const dir = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      if (!dir) throw new Error("path is required");
      const result = store.openDiskFolder(path.resolve(dir), parseFolderRef(req.body?.folderId));
      res.status(201).json(result);
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  /** Where new files go and whether deleting a file page also bins its file (#707). */
  app.get("/api/files/settings", (req, res) => {
    if (refuseAgent(req, res)) return;
    res.json({ settings: store.fileSettings(), unwatched: store.unwatchedDisk() });
  });

  app.put("/api/files/settings", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      const pick = (value: unknown) => (value === null ? null : typeof value === "string" ? value : undefined);
      res.json({ settings: store.setFileSettings({ defaultLocation: pick(req.body?.defaultLocation), deleteFiles: pick(req.body?.deleteFiles) }) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  /**
   * A new empty file as a page (#707): name (e.g. Untitled.md) in folderId's disk location or the
   * default one, or file (an exact path). 409 needsLocation when neither applies: the board asks
   * for location (remember: make it the default) and tries again.
   */
  app.post("/api/files/create", (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
      const tab = store.createFile({
        folderId: parseFolderRef(req.body?.folderId),
        name: text(req.body?.name),
        file: text(req.body?.file),
        location: text(req.body?.location),
        remember: req.body?.remember === true,
        activate: req.body?.activate !== false,
      });
      res.status(201).json({ tab: toMeta(tab) });
    } catch (err) {
      if (err instanceof NeedsLocationError) {
        res.status(409).json({ error: err.message, needsLocation: true });
        return;
      }
      if (err instanceof FileExistsError) {
        res.status(409).json({ error: err.message, exists: err.target });
        return;
      }
      sendStoreError(res, err);
    }
  });

  /**
   * A dropped file (the browser gives its bytes, not its path). A Scribe export still imports as
   * pages; anything else becomes a file page holding a copy.
   */
  app.post("/api/files/upload", express.raw({ type: "application/octet-stream", limit: MAX_IMPORT_BYTES }), (req, res) => {
    if (refuseAgent(req, res)) return;
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error("expected a file body");
      // Encoded by the board: a header cannot carry most non-Latin names as they are.
      let name = importFilename(req);
      try {
        name = decodeURIComponent(name);
      } catch {
        /* sent as is */
      }
      const folderId = parseFolderRef(req.query.folderId);
      const activate = req.query.activate !== "0";
      if (/\.json$/i.test(name) && !folderId) {
        let parsed: ReturnType<typeof parseImport> | null = null;
        try {
          parsed = parseImport(req.body, name);
        } catch {
          parsed = null;
        }
        if (parsed?.kind === "export") {
          const result = store.importBoard(parsed, activate ? "meta" : "closed");
          res.status(201).json({ kind: "export", opened: result.opened, closed: result.closed, focusedId: result.focusedId, templatesCreated: result.templatesCreated });
          return;
        }
      }
      const { tab } = store.openFilePage({ name, bytes: req.body, folderId, activate });
      res.status(201).json({ kind: "file", tab: toMeta(tab) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/tabs/:id/file/open-location", (req, res) => {
    if (refuseAgent(req, res)) return;
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      const folder = path.dirname(path.resolve(tab.file.path));
      if (!fs.statSync(folder).isDirectory()) throw new Error("folder not found");
      const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      // The user clicked to see this folder window; keep Explorer visible.
      const child = spawn(command, [folder], { stdio: "ignore", detached: true, windowsHide: false });
      child.once("error", err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      child.once("spawn", () => { child.unref(); res.json({ ok: true }); });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/tabs/:id/file", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(readFileForPage(tab.file.path, tab.file.copy));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message, path: tab.file.path });
    }
  });

  // The page access middleware protects this route, including for Pages mode chats.
  app.get("/api/tabs/:id/file/text", async (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab?.file) { res.status(404).json({ error: "not a file page" }); return; }
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await readPdfText(tab.file.path, req.query.page === undefined ? 1 : Number(req.query.page), req.query.limit === undefined ? 1 : Number(req.query.limit)));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/tabs/:id/file/raw", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      const { bytes, type } = readFileBytes(tab.file.path);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.type(type).send(bytes);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /** An image file page's image for page_read, like a page asset: base64 data, or why it was skipped. */
  app.get("/api/tabs/:id/file/image", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      const { bytes, type } = readFileBytes(tab.file.path);
      const skipped = skipInlinePageImage(type, bytes.length);
      res.setHeader("Cache-Control", "no-store");
      res.json({ mimeType: type, bytes: bytes.length, ...(skipped ? { skipped } : { data: bytes.toString("base64") }) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /**
   * An image a file page's markdown links to (?src=): relative to the file, an absolute path, or a
   * file: URL. The board's only: for an agent it would read any image on disk.
   */
  app.get("/api/tabs/:id/file/asset", (req, res) => {
    if (refuseAgent(req, res)) return;
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    const target = linkedImagePath(tab.file.path, String(req.query.src ?? ""));
    if (!target) {
      res.status(415).json({ error: "not an image" });
      return;
    }
    try {
      const { bytes, type } = readFileBytes(target);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.type(type).send(bytes);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /** Save: { text, mtime, eol, bom, force }. 409 { conflict, mtime } when the file changed on disk since mtime. */
  app.put("/api/tabs/:id/file", (req, res) => {
    if (refuseAgent(req, res)) return;
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      if (typeof req.body?.text !== "string") throw new Error("text is required");
      const info = writeFileText(tab.file.path, req.body.text, {
        expectedMtime: optionalNumber(req.body.mtime),
        force: req.body.force === true,
        eol: req.body.eol,
        bom: req.body.bom === true,
      });
      res.json({ ...info, ...(tab.file.copy ? { copy: true } : {}) });
    } catch (err) {
      if (err instanceof FileConflictError) {
        res.status(409).json({ error: err.message, conflict: true, mtime: err.mtime });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Save as: { path, text, eol, bom, overwrite }. 409 { exists } when path is taken and overwrite is not set. */
  app.post("/api/tabs/:id/file/save-as", (req, res) => {
    if (refuseAgent(req, res)) return;
    const tab = store.get(req.params.id);
    if (!tab?.file) {
      res.status(404).json({ error: "not a file page" });
      return;
    }
    try {
      const raw = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      if (!raw) throw new Error("path is required");
      if (typeof req.body?.text !== "string") throw new Error("text is required");
      const target = path.resolve(raw);
      const other = store.findFilePage(target);
      if (other && other.id !== tab.id) throw new Error(`${path.basename(target)} is open in another page (${other.title})`);
      if (fs.existsSync(target) && req.body.overwrite !== true && !samePath(target, tab.file.path)) {
        res.status(409).json({ error: "A file with that name already exists", exists: true });
        return;
      }
      const info = writeFileText(target, req.body.text, { force: true, create: true, eol: req.body.eol, bom: req.body.bom === true });
      const updated = store.setFilePath(tab.id, target);
      res.json({ ...info, tab: toMeta(updated) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/import", express.raw({ type: "application/octet-stream", limit: MAX_IMPORT_BYTES }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "expected a file body" });
        return;
      }
      const destination = parseImportDestination(req.query.destination);
      const transfer=await importTransfer(req.body,importFilename(req));
      if(req.query.preview==="1"){
        res.json({pages:transfer.parsed?.pages.length??0,plugins:transfer.packages.map(p=>({...pluginService.preview(p.files,true),archive:p.archive.toString("base64")}))});return;
      }
      if(!transfer.parsed){res.json({kind:"plugin",opened:0,closed:0,templatesCreated:0});return;}
      const parsed = transfer.parsed;
      const result = store.importBoard(parsed, destination);
      res.status(201).json({
        kind: parsed.kind,
        imported: result.tabs.map((tab) => toMeta(tab)),
        opened: result.opened,
        closed: result.closed,
        focusedId: result.focusedId,
        templatesCreated: result.templatesCreated,
        templatesReused: result.templatesReused,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/shutdown", async (_req, res) => {
    await pluginService.close();
    void peers.stop();
    searchEmbedder.stop();
    res.json({ ok: true });
    try {
      agentHost?.dispose();
    } catch {
      /* ignore */
    }
    try {
      store.closeDb();
    } catch {
      /* already logged */
    }
    void Promise.all([searchIndex.close(), closeScreenshotBrowser(), closeAgentBrowser()]).finally(() => process.exit(0));
  });

  const server = http.createServer(app);
  server.once("close", () => { searchEmbedder.stop(); void searchIndex.close(); });
  const contentServer = http.createServer(app);
  // A page's script or a website must not read every page off the board's socket (#660).
  const wss = new WebSocketServer({ noServer: true, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  // Two servers attached to one HTTP server abort each other's upgrades, so upgrades are routed by path.
  // A socket another device's UI opened over the peer link (#905) is compressed: it crosses the network.
  const linkWss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 }, verifyClient: ({ req }: { req: http.IncomingMessage }) => socketAllowed(req.headers, req.socket) });
  server.on("upgrade", (req, socket, head) => {
    if (gateway.upgrade(req, socket, head)) return;
    if (audioStream.handle(req, socket, head)) return;
    if (new URL(req.url || "/", "http://x").pathname !== "/ws") { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    (peerDeviceOf(req.socket) ? linkWss : wss).handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    viewers.add(socket);
    send(socket, { type: "snapshot", version: VERSION, ...store.snapshot() });
    socket.on("message", (raw) => {
      let msg: {
        type?: string;
        selectedId?: string | null;
        lastInteractedAt?: unknown;
        lastEditAt?: unknown;
        hidden?: unknown;
      };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg?.type !== "viewer_state") {
        return;
      }
      viewers.update(socket, {
        selectedId: msg.selectedId,
        lastInteractedAt: msg.lastInteractedAt,
        lastEditAt: msg.lastEditAt,
        hidden: msg.hidden,
      });
    });
    socket.on("close", () => {
      sockets.delete(socket);
      viewers.remove(socket);
    });
  });

  store.on("tab_upserted", (tab: TabMeta, index?: number, notice?: UpsertNotice) => {
    const threadId = notice?.thread;
    if (notice?.activate && notice.structural && threadId) {
      // Re-scope before the client sees the new tab, so the dock can keep this chat.
      agentHost?.followToPage(threadId, tab.id);
    }
    broadcast({ type: "tab_upserted", tab, index, structural: notice?.structural !== false, ...(notice?.template ? { template: true } : {}), ...(notice?.markUnread === false ? { markUnread: false } : {}) });
    if (notice?.activate && notice.structural) {
      requestAgentFocus(tab.id, threadId);
    }
  });
  store.on("tab_deleted", (id: string) => broadcast({ type: "tab_deleted", id }));
  store.on("spaces", (spaces: SpacesView) => broadcast({ type: "spaces", spaces }));
  // A space switch swaps the whole strip: one fresh snapshot instead of a close and an open per tab.
  store.on("reset", () => broadcast({ type: "snapshot", version: VERSION, reset: true, ...store.snapshot() }));
  store.on("folders", (folders: Folder[]) => broadcast({ type: "folders", folders }));
  store.on("trash", () => broadcast({ type: "trash" }));
  store.on("tab_state", (tab: Tab, delta: { fromRevision: number; ops: StateOp[]; client?: string; writeId?: string }) => {
    // A card that came in, or a worker the user started, is picked up soon.
    if (store.drives(tab)) scheduleSweep(500);
    broadcast({
      type: "tab_state",
      id: tab.id,
      fromRevision: delta.fromRevision,
      stateRevision: tab.stateRevision,
      ops: delta.ops,
      ...(delta.client ? { client: delta.client } : {}),
      ...(delta.writeId ? { writeId: delta.writeId } : {}),
    });
  });
  store.on("tab_event", (tab: Tab, event: PageEvent) => broadcast({ type: "tab_event", id: tab.id, event }));
  store.on("template_upserted", (template: TemplateMeta) => broadcast({ type: "template_upserted", template }));
  store.on("template_deleted", (id: string) => broadcast({ type: "template_deleted", id }));
  store.on("builtin_templates", (templates: BuiltinTemplateMeta[]) => broadcast({ type: "builtin_templates", templates }));
  store.on("page_asset_warning", (tab: Tab, usage: PageAssetUsage) =>
    broadcast({ type: "page_asset_warning", id: tab.id, title: tab.title, usage })
  );
  store.on("persist_error", (error: string) => broadcast({ type: "persist_error", error }));
  store.on("persist_ok", () => broadcast({ type: "persist_ok" }));

  // Covers receiving the request (large imports), not a slow response, so it does not bound page_wait.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  contentServer.requestTimeout = REQUEST_TIMEOUT_MS;

  await listen(server, PORT, HOST);
  await listen(contentServer, PORT, CONTENT_HOST);
  peers.attach(server);
  await peers.start().catch((err) => log(`Peer link could not start: ${(err as Error).message}`));
  void prebuildEditorBundle();

  log(`Scribe listening on ${baseUrl()} (tab pages on their own *${PAGE_HOST_SUFFIX} origins)`);
  agentHost?.resumeInterrupted();
  return server;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** TabMeta plus the page's Library folder path for agents and search results. */
function libraryMeta(tab: Tab): TabMeta & { open: boolean; folder: string | null } {
  return { ...toMeta(tab), open: !tab.closedAt, folder: store.folderPath(tab.folderId) };
}

function parseFolderRef(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("folderId must be a folder id or null");
  }
  return value;
}

const rawAssetBody = express.raw({ type: "application/octet-stream", limit: MAX_PAGE_ASSET_BYTES });

/** express.raw, but a body over the limit answers in JSON like the rest of the API. */
function readAssetBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
  rawAssetBody(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? `asset is too large (max ${MAX_PAGE_ASSET_BYTES} bytes)` : (err as Error).message,
    });
  });
}

function assetView(asset: PageAssetMeta): PageAssetMeta & { url: string } {
  return { ...asset, url: pageAssetUrl(asset.id) };
}

function sendAssetError(res: express.Response, err: unknown): void {
  const message = (err as Error).message;
  const missing = message.startsWith("tab not found") || message.startsWith("asset not found");
  const full = message.startsWith("page asset");
  res.status(missing ? 404 : full ? 413 : 400).json({ error: message });
}

function decodeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sendStoreError(res: express.Response, err: unknown): void {
  const message = (err as Error).message;
  const missing = message.startsWith("tab not found") || message.startsWith("folder not found");
  res.status(missing ? 404 : 400).json({ error: message });
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function handleWait(
  req: express.Request,
  res: express.Response,
  namesInput: unknown,
  afterInput: unknown,
  timeoutInput: unknown,
  whereInput: unknown
): void {
  let names: string[];
  let where: ReturnType<typeof parseWhere>;
  try {
    names = parseEventNames(namesInput);
    where = parseWhere(whereInput);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const timeoutMs = clampWaitMs(typeof timeoutInput === "string" ? Number(timeoutInput) : timeoutInput);
  req.setTimeout(timeoutMs + 10_000);
  res.setTimeout(timeoutMs + 10_000);

  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) {
      abort.abort();
    }
  };
  res.on("close", onClientGone);

  waitForEvents({
    idOrKey: req.params.id,
    names,
    after: parseCursor(typeof afterInput === "string" ? Number(afterInput) : afterInput),
    timeoutMs,
    viewer: viewerOf(req),
    abort: abort.signal,
    ...(where ? { where } : {}),
  })
    .then((result) => {
      if (!res.writableEnded) {
        res.json(result);
      }
    })
    .catch((err: Error) => {
      if (res.writableEnded) {
        return;
      }
      res.status(err.message.startsWith("tab not found") ? 404 : 400).json({ error: err.message });
    })
    .finally(() => {
      res.off("close", onClientGone);
    });
}

/** Last request from each MCP session, for telling a live agent's claims from an abandoned one's. */
const sessionSeen = new Map<string, number>();

function noteAgentSession(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const session = req.get(SESSION_HEADER);
  if (session && !isContentHost(req)) {
    sessionSeen.set(session.slice(0, 40), Date.now());
  }
  next();
}

function callerOf(req: express.Request): ActionCaller {
  if (isContentHost(req) || viewerOf(req) !== "agent") {
    return { by: "user", label: "user" };
  }
  const session = req.get(SESSION_HEADER)?.slice(0, 40);
  const thread = threadOf(req);
  const chat = thread && agentHost ? agentHost.getThread(thread) : null;
  const label = chat ? `Scribe chat: ${chat.title}` : req.get(AGENT_LABEL_HEADER)?.slice(0, 60) || "agent";
  return { by: "agent", label, ...(chat?.provider ? { provider: chat.provider } : {}), ...(session ? { session } : {}), ...(thread ? { thread } : {}) };
}

function actorOf(req: express.Request): PageActor | undefined {
  if (isContentHost(req) || viewerOf(req) !== "agent") {
    return undefined;
  }
  const thread = threadOf(req);
  const chat = thread && agentHost ? agentHost.getThread(thread) : null;
  const title = chat?.title?.trim().slice(0, 120);
  const workspace = chat && agentHost ? agentHost.threadFolder(chat) : null;
  const scope = chat?.scope;
  const origin = scope?.ref && (scope.kind === "page" || scope.kind === "folder") ? { kind: scope.kind, id: scope.ref } : undefined;
  const space = chat?.space;
  return { at: Date.now(), ...(thread ? { thread } : {}), ...(title ? { title } : {}), ...(workspace ? { workspace } : {}), ...(origin ? { origin } : {}), ...(space ? { space } : {}) };
}

/** The page of the chat thread making this request, when that page is still blank: a new page it shows fills it. */
function threadBlankPage(req: express.Request): string | undefined {
  if (isContentHost(req) || viewerOf(req) !== "agent") {
    return undefined;
  }
  const thread = threadOf(req);
  const scope = thread && agentHost ? agentHost.getThread(thread)?.scope : undefined;
  const page = scope?.kind === "page" && scope.ref ? store.get(scope.ref) : undefined;
  return page && isBlankPage(page) ? page.id : undefined;
}

let sweepQueued: NodeJS.Timeout | null = null;
/** Threads last seen waiting on the user, so the sweep runs when that changes. */
const waitingThreads = new Set<string>();

/** Release or flag claims whose agent stopped. Debounced: turn ends come in bursts. */
function scheduleSweep(delayMs: number): void {
  if (sweepQueued) {
    return;
  }
  sweepQueued = setTimeout(async () => {
    sweepQueued = null;
    const ctx = {
      now: Date.now(),
      thread: (id: string) => (agentHost ? agentHost.runInfo(id) : { exists: false as const }),
      sessionSeenAt: (session: string) => sessionSeen.get(session),
    };
    store.sweepActions(ctx);
    const host = agentHost;
    if (!host) return;
    const available = (await host.providerStatus().catch(() => [])).filter((p) => p.available).map((p) => p.id);
    const defaultProvider = ["cursor", "codex", "claude", "pi"].find((id) => available.some((p) => p === id)) ?? available[0];
    // Then the pages' own agents (Kanban workers) go on, whether or not a window shows them (#312).
    const driveContext = {
        ...ctx,
        now: Date.now(),
        defaultProvider,
        watch: (thread: string, run: import("./actions/types.js").PageRunInput) => {
          try {
            host.watchPageThread(thread, run);
            return true;
          } catch (err) {
            log(`Could not see a page's chat through: ${(err as Error).message}`);
            return false;
          }
        },
        release: (thread: string) => {
          try {
            host.releasePageThread(thread);
          } catch {
            /* the chat is gone */
          }
        },
      };
    const launch=(pageId:string,item:import("./actions/types.js").PageLaunch,validate:()=>void|Promise<void>)=>host.launchPageThread(pageId,item.prompt,item.settings,item.run,item.resumeThread,validate);
    store.driveActions(driveContext,launch);
    await pluginActions?.sweep(ctx,driveContext,launch);
  }, delayMs);
  sweepQueued.unref?.();
}

/** A viewer id from the page's boot (set per desktop app or browser by the Scribe UI). */
function viewerIdOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
}

/** page_show / page_patch replyTo: undefined leaves it, null clears it. */
function parseReplyTo(value: unknown): { page: string; card?: unknown } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value) || typeof value.page !== "string" || !value.page.trim()) {
    throw new Error("replyTo must be { page, card? } or null");
  }
  return { page: value.page.trim(), ...(value.card !== undefined ? { card: value.card } : {}) };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const BOARD_CHROME_INJECT = `<style data-scribe-scroll>${BOARD_SCROLLBAR_CSS}</style>
<script data-scribe-keys>
(function () {
  function typing(el) {
    if (!el || el === document.body) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return Boolean(el.isContentEditable);
  }
  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    var key = event.key.toLowerCase();
    if ((key === "t" || key === "n") && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-shortcut", action: "new-page" }, "*");
      return;
    }
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-download" }, "*");
      return;
    }
    if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-help" }, "*");
      return;
    }
    if (key === "z" && !event.shiftKey && !typing(event.target)) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-undo" }, "*");
      return;
    }
    if (key === "d" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-palette" }, "*");
    }
  }, true);
  // Bubble phase: a page that handles Esc itself (closing its own menu) keeps it.
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      parent.postMessage({ type: "scribe-escape" }, "*");
      return;
    }
    // Agent chat: Ctrl+K floating chat, Ctrl+Shift+K new thread, Ctrl+L sidebar, Ctrl+Shift+L full window,
    // Ctrl+J threads, Ctrl+' next favourite model, Ctrl+Alt+' next reasoning level, Ctrl+Shift+' next mode,
    // Ctrl+. next workspace then none, Ctrl+Shift+. next Scribe access.
    // Pages that use them keep them.
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return;
    if ((event.altKey && event.key.toLowerCase() === "s") || (!event.altKey && (event.code === "Comma" || event.key === "," || event.key === "<"))) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-shortcut", action: event.shiftKey ? "agent-settings" : "settings" }, "*");
      return;
    }
    // Spaces: Ctrl+E shows them, Ctrl+Shift+PageUp / PageDown switches to the previous / next one.
    // Library: Ctrl+B shows or hides the sidebar.
    var boardAction = event.altKey ? ""
      : event.key.toLowerCase() === "e" && !event.shiftKey ? "spaces"
      : event.key.toLowerCase() === "b" && !event.shiftKey ? "library"
      : event.shiftKey && event.key === "PageUp" ? "prev-space"
      : event.shiftKey && event.key === "PageDown" ? "next-space" : "";
    if (boardAction) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-shortcut", action: boardAction }, "*");
      return;
    }
    var chatKey = event.key.toLowerCase();
    // Only shortcuts that open chat belong to a page; thread actions require chat focus.
    var action = event.altKey ? ""
      : chatKey === "k" && !event.shiftKey ? "dock"
      : chatKey === "l" ? (event.shiftKey ? "full" : "side") : "";
    if (action) {
      event.preventDefault();
      // With text selected, Ctrl+K and Ctrl+L open the chat with the selection attached.
      var picked = action === "dock" || action === "side" ? selectedText() : "";
      parent.postMessage(picked ? { type: "scribe-chat-key", action: action, selection: picked } : { type: "scribe-chat-key", action: action }, "*");
    }
  });
  var SELECTION_MAX = 20000;
  function selectedText() {
    var el = document.activeElement;
    var text = "";
    if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|email|tel)?$/i.test(el.type || "")))) {
      try { text = el.value.slice(el.selectionStart || 0, el.selectionEnd || 0); } catch (err) {}
    } else {
      var sel = window.getSelection();
      text = sel ? String(sel) : "";
    }
    text = text.trim();
    return text.length > SELECTION_MAX ? text.slice(0, SELECTION_MAX) + "\\n…" : text;
  }
  // Right-click opens Scribe's menu (Ask agent, Copy, …). A page with its own menu keeps it, text fields
  // keep the browser's (cut, paste, spelling), and Shift+right-click always gets the browser's.
  var menuOpen = false;
  window.addEventListener("contextmenu", function (event) {
    if (event.defaultPrevented || event.shiftKey) return;
    if (typing(event.target)) return;
    event.preventDefault();
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    var href = link ? link.href : "";
    menuOpen = true;
    parent.postMessage({ type: "scribe-context-menu", x: event.clientX, y: event.clientY, selection: selectedText(), link: /^https?:/i.test(href) ? href : "", context: menuContext(event.target) }, "*");
  });
  // What the page says is under the cursor, for template agent actions' placeholders: the
  // data-scribe-context JSON objects on the element and its ancestors, the nearest one winning per name.
  function menuContext(node) {
    var out = {};
    for (var el = node && node.nodeType === 1 ? node : node && node.parentElement; el; el = el.parentElement) {
      var raw = el.getAttribute && el.getAttribute("data-scribe-context");
      if (!raw) continue;
      var data = null;
      try { data = JSON.parse(raw); } catch (err) {}
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      Object.keys(data).forEach(function (name) {
        var value = data[name];
        if (!(name in out) && /^[a-z][a-z_]{0,29}$/.test(name) && (typeof value === "string" || typeof value === "number")) out[name] = String(value).slice(0, 2000);
      });
    }
    return out;
  }
  // The menu lives in the board; a click, key or scroll in here closes it. Esc closes only the menu.
  function closeMenu(event) {
    if (!menuOpen) return;
    menuOpen = false;
    parent.postMessage({ type: "scribe-context-menu-close" }, "*");
    if (event.type === "keydown" && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  window.addEventListener("pointerdown", closeMenu, true);
  window.addEventListener("keydown", closeMenu, true);
  window.addEventListener("wheel", closeMenu, { capture: true, passive: true });
  // Choosing an item, or clicking anywhere else in the board, takes focus from the page and closes the menu.
  window.addEventListener("blur", function () { menuOpen = false; });
  // The board gives the focus back after its chat closes (#829): return it to the field the page had.
  var lastFocus = null;
  document.addEventListener("focusin", function (event) { lastFocus = event.target; }, true);
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data) return;
    if (event.data.type === "scribe-refocus") {
      if (lastFocus && lastFocus.isConnected && lastFocus !== document.body && lastFocus.focus) {
        try { lastFocus.focus({ preventScroll: true }); } catch (err) {}
      }
      return;
    }
    if (event.data.type === "scribe-select-all") {
      var sel = window.getSelection();
      if (sel && document.body) sel.selectAllChildren(document.body);
    }
  });
})();
</script>`;

function collectPageProblems(req: express.Request, tab: Tab) {
  if (req.body?.checkProblems !== true || tab.file || tab.browser || embedUrlFromHtml(tab.html)) return Promise.resolve([]);
  const reach = reachFor(req);
  return pageProblems.collect(tab.id, tab.revision, signal => probeTab(tab.id, signal), { exists: key => {
    const linked = store.get(key);
    if (linked && (reach ? reach(linked) !== "allow" : linked.agentHidden)) return undefined;
    return Boolean(linked);
  } });
}

function injectBoardRuntime(tab: Tab, viewer: string | null, captureLocal?: BoardState): string {
  const html = injectBoardKeys(tab.browser ? browserViewHtml() : tab.file ? fileViewerHtml() : rewriteAssetRefs(tab.html, tab.id));
  if (html.includes("data-scribe-bridge")) {
    return html;
  }
  const capturing = captureLocal !== undefined;
  const boot = jsonForScript({
    id: tab.id,
    title: tab.title,
    state: tab.state,
    stateRevision: tab.stateRevision,
    viewer: capturing ? null : viewer,
    capture: capturing,
    local: capturing ? captureLocal : viewer ? store.getLocal(tab.id, viewer) : {},
    template: tab.templateId
      ? {
          id: tab.templateId,
          values: tab.templateValues ?? {},
          revision: tab.templateStateVersion ?? 0,
          compatible: tab.templateCompatible !== false,
        }
      : null,
  });
  const diagnostic = tab.browser ? null : pageProblems.boot(tab.id, tab.revision);
  const opening = /<head[^>]*>/i.exec(html) || /<body[^>]*>/i.exec(html);
  const at = opening ? opening.index + opening[0].length : 0;
  const problemBoot = diagnostic ? {
    ...diagnostic, id: tab.id, capture: capturing, tones: KIT_TONES,
    insertLine: html.slice(0, at).split("\n").length, insertedLines: 0,
  } : null;
  const renderSnippet = () => `<script src="/tooltip.js?v=3" defer></script>
<style data-scribe-bridge>${BOARD_STALE_CSS}</style>
<script>window.__SCRIBE_BOOT__=${boot};
${problemBoot ? `window.__SCRIBE_PROBLEMS__=${jsonForScript(problemBoot)};\n${PAGE_PROBLEM_JS}` : ""}
${BOARD_BRIDGE_JS}
${diagnostic ? "window.__scribeWatchProblems && window.__scribeWatchProblems();" : ""}
</script>`;
  // JSON boot data contains no literal newlines, so filling the count cannot change it.
  if (problemBoot) problemBoot.insertedLines = renderSnippet().split("\n").length - 1;
  return injectIntoHead(html, renderSnippet());
}

function injectBoardKeys(html: string): string {
  if (html.includes("data-scribe-keys")) {
    return html;
  }
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) {
    return html + BOARD_CHROME_INJECT;
  }
  return html.slice(0, idx) + BOARD_CHROME_INJECT + html.slice(idx);
}

/** The bridge has to exist before any page script runs, so it goes as early as the document allows. */
function injectIntoHead(html: string, snippet: string): string {
  const opening = /<head[^>]*>/i.exec(html) || /<body[^>]*>/i.exec(html);
  if (!opening) {
    return snippet + html;
  }
  const at = opening.index + opening[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*]+/g, " ").trim().replace(/\s+/g, "-");
  return (cleaned || "page").slice(0, 80);
}

function parseImportDestination(value: unknown): ImportDestination {
  if (value === undefined || value === null || value === "" || value === "meta") {
    return "meta";
  }
  if (value === "closed") {
    return "closed";
  }
  throw new Error("destination must be meta or closed");
}

function instanceCount(template: Template, viewer: Viewer): number {
  return store.listTemplates(viewer).find((item) => item.id === template.id)?.instanceCount ?? 0;
}

/** A page's risky permissions were granted to the code the user saw; an agent rewriting it resets them. */
function agentRewrote(req: express.Request, tabId: string): void {
  if (viewerOf(req) === "agent") {
    store.resetRiskyPermissions(tabId);
  }
}

/** File writes are the user's: agents edit files with their own tools. True when it answered. */
function refuseAgent(req: express.Request, res: express.Response): boolean {
  if (viewerOf(req) !== "agent") return false;
  res.status(403).json({ error: "Only the board opens and saves file pages" });
  return true;
}

function viewerOf(req: express.Request): Viewer {
  return identify(req).viewer;
}

/** The chat thread the request proved it comes from (#682); a bare thread header counts for nothing. */
function threadOf(req: express.Request): string | undefined {
  return identify(req).thread;
}

/**
 * Which pages an agent's request may reach (#269): its chat thread's, or for an external MCP client
 * (no Scribe chat, #682), a global untrusted chat's. A caller that proved neither reaches none. Null
 * for the board UI and page code (frameReach, #660).
 */
function reachFor(req: express.Request, read = req.method === "GET"): ((tab: Tab) => Reach) | null {
  if (isContentHost(req) || viewerOf(req) !== "agent") return null;
  const { thread, external } = identify(req);
  const reader: PageReader | null | undefined = thread
    ? agentHost?.pageReader(thread)
    : external
      ? { scope: { kind: "global", ref: null }, trusted: false, grants: [] }
      : null;
  if (!reader) return () => "hidden";
  const lookup = store.accessLookup();
  // Read-only access (#762, #818) opens only reads.
  return (tab) => pageReach(reader, agentHost ? agentHost.accessPage(tab) : { ...tab, createdBy: tab.provenance?.created?.thread }, lookup, read);
}

/**
 * Whether the page whose origin the request came in on may reach tab (#660). Grants let a page's
 * script read another page; it writes only its own, where its writes count as the user's.
 */
function reachedByFrame(req: express.Request, tab: Tab): boolean {
  const from = framePageId(req);
  if (!from) return false;
  if (from === tab.id) return true;
  if (req.method !== "GET") return false;
  return frameReach(from, agentHost ? agentHost.accessPage(tab) : { ...tab, createdBy: tab.provenance?.created?.thread }, store.accessLookup());
}

/** Whether a page the agent makes in this folder would stay within its reach (#260). */
function homeFits(req: express.Request, reach: (tab: Tab) => Reach): (folderId: string) => boolean {
  const thread = threadOf(req);
  const actor = actorOf(req);
  return (folderId) =>
    reach({
      id: "t_00000000",
      folderId,
      ...(actor?.origin ? { access: { origin: actor.origin } } : {}),
      ...(thread ? { provenance: { created: { thread, at: 0 } } } : {}),
    } as Tab) === "allow";
}

/** Only the pages the agent may reach, for listings and searches. */
function reachable(req: express.Request): ((tab: Tab) => boolean) | undefined {
  const reach = reachFor(req);
  return reach ? (tab) => reach(tab) === "allow" : undefined;
}

/** Open the way to a page for the request, or answer for it: out of reach is not found, or a pointer to page_access. */
function checkReach(req: express.Request, res: express.Response, tab: Tab): boolean {
  let reach = reachFor(req)?.(tab) ?? "allow";
  // A page the chat may only read still answers its actions, run read-only (#818): list and get work, changes are refused.
  if (reach !== "allow" && req.method === "POST" && /^\/api\/tabs\/[^/]+\/action$/.test(req.path) && reachFor(req, true)?.(tab) === "allow") {
    reach = "allow";
    res.locals.readOnlyReach = `${tab.key} ("${tab.title}") is readable but outside this chat's Scribe access for changes, so this action, which changes it, was refused. Ask the user with page_access to change it.`;
  }
  if (reach === "allow") {
    const thread = threadOf(req);
    if (thread && agentHost && viewerOf(req) === "agent" && !isContentHost(req)) agentHost.notePageReached(thread, tab);
    return true;
  }
  const askable = reach === "ask" || reach === "request";
  res.status(askable ? 403 : 404).json({ error: reachMessage(reach, tab), ...(askable ? { access: "ask" } : {}) });
  return false;
}

/**
 * Pages outside the agent's access whose titles match the query, for a search to list after its hits:
 * titles only, no text, so the agent can ask for the right one (#269).
 */
function outsideTitles(req: express.Request, tabs: Tab[], query: string, limit = 10): Array<ReturnType<typeof libraryMeta> & { outside: true }> {
  const reach = reachFor(req);
  if (!reach) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tabs
    .filter((tab) => reach(tab) === "ask" && (!words.length || words.every((w) => `${tab.title} ${tab.key}`.toLowerCase().includes(w))))
    .slice(0, limit)
    .map((tab) => ({ ...libraryMeta(tab), outside: true as const }));
}

function importFilename(req: express.Request): string {
  const raw = req.get("x-filename") || "import";
  return path.basename(raw).slice(0, 180) || "import";
}

function requestAgentFocus(tabId: string, threadId?: string): void {
  const target = viewers.focusTarget(tabId);
  if (!target || target === "already-visible") {
    return;
  }
  send(target.socket, { type: "tab_focus_request", id: tabId, ...(threadId ? { thread: threadId } : {}) });
}

function send(socket: WebSocket, event: BoardEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function broadcast(event: BoardEvent): void {
  for (const socket of sockets) {
    send(socket, event);
  }
}
