import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { cleanupOrphanAssets, deleteTabAssets, normalizeTabAssets, readPreparedAssets, writePreparedAssets } from "./assets.js";
import { buildExport, type BoardExportFile, type BoardExportFolder, type ImportPageInput } from "./boardExport.js";
import { BUILTIN_ID_PREFIX, isBuiltinId, loadBuiltinTemplates } from "./builtinTemplates.js";
import { searchLibrary as rankLibrary, LIBRARY_PAGE_DEFAULT, type LibrarySearchResult } from "./librarySearch.js";
import { searchPages as rankPages, PAGE_SEARCH_DEFAULT, type PageSearchResult } from "./pageSearch.js";
import {
  ASSET_SWEEP_INTERVAL_MS,
  MAX_HTML_BYTES,
  MAX_EVENT_DATA_BYTES,
  MAX_LOCAL_STATE_BYTES,
  MAX_PAGE_EVENTS,
  MAX_STATE_BYTES,
  PAGE_ASSET_ORPHAN_GRACE_MS,
  dbPath,
  statePath,
} from "./config.js";
import { BoardDb, type StoredFolder, type StoredTab } from "./db.js";
import { log } from "./log.js";
import {
  assertPageAssetRoom,
  assertPageAssetSize,
  cleanPageAssetName,
  collectPageAssetRefs,
  isPageAssetId,
  newPageAssetId,
  normalizePageAssetMime,
  pageAssetUrl,
  pageAssetUsage,
  readPageAssetFile,
  remapPageAssetRefs,
  substituteStateAssets,
  type PageAssetFile,
  type PageAssetDraft,
  type PageAssetInput,
  type PageAssetMeta,
  type PageAssetUsage,
} from "./pageAssets.js";
import { checkPermission, normalizeFolders, isPermissionValue, permissionDef, type FolderGrant, type PermissionGrant, type PermissionNeed, type PermissionValue } from "./pagePermissions.js";
import { normalizeSignalName } from "./signal.js";
import { addTargets, effectiveLevel, inheritedFolderLevel, isOpenLevel, sameTarget, type AccessLookup } from "./pageAccess.js";
import type { AccessLevel, AccessTarget } from "./types.js";
import { normalizeLens } from "./lens.js";
import { applyOps, deepEqual } from "./stateOps.js";
import { jsonBytes } from "./stateSize.js";
import { normalizeEvents } from "./events.js";
import { upgradeLegacyHtml } from "./legacyPages.js";
import { BUILTIN_ACTIONS, describeActions, type ActionCaller, type ActionContext, type ActionSet, type InboundReply, type ReplyDelivery, type RunEvent, type SweepContext } from "./actions/index.js";
import type { DriveContext, LaunchSettings, PageLaunch } from "./actions/types.js";
import type { RunNote } from "./agent/pageRuns.js";
import {
  TRASH_TTL_MS,
  USER_TITLE_HOLD_MS,
  PAGE_KEY_PREFIX,
  normalizeKey,
  pageKey,
  WELCOME_KEY,
  isAppTab,
  isBlankPage,
  NEW_PAGE_TITLE,
  isPlainObject,
  isTemplateBound,
  noteAgentWrite,
  normalizeReplyTo,
  toMeta,
  toTemplateMeta,
  visibleTo,
  type BoardState,
  type DeletedBatch,
  type Folder,
  type FolderInstruction,
  type ImportDestination,
  type RestorePlacement,
  type EventInput,
  type PageActor,
  type PageEvent,
  type ReplyTarget,
  type StateWriteInput,
  type StateWriteResult,
  type Tab,
  type TabAsset,
  type TabMeta,
  type BuiltinTemplateMeta,
  type Template,
  type TemplateBinding,
  type TemplateMeta,
  type TemplateValues,
  type TrashBatch,
  type UpsertInput,
  type UpsertNotice,
  type Viewer,
} from "./types.js";
import {
  SPACE_UNDO_MAX,
  cleanSpaceName,
  emptySpaces,
  isSpaceColor,
  newSpaceId,
  nextSpaceColor,
  nextSpaceName,
  parseSpaces,
  type Space,
  type SpacesData,
  type SpacesView,
  type SpaceTab,
} from "./spaces.js";
import { applyEdits, assertRevision, toLf, type HtmlEdit, type HtmlEditResult } from "./htmlEdit.js";
import {
  mergeTemplateValues,
  normalizeTemplateInput,
  parseTemplateValues,
  renderTemplateTitle,
  templateSetsTitle,
  substituteTemplate,
  templateFingerprint,
  type TemplateUpsertInput,
} from "./templates.js";
import { wrapHtml } from "./wrapHtml.js";
import { embedPageHtml, embedUrlFromHtml, safeEmbedUrl } from "./embed.js";
import { removeCopies, safeFileName, samePath, scanFolder, storeCopy, filePlaceholderHtml, type FolderEntry } from "./filePages.js";
import { createEmptyFile, DiskLinkTakenError, DiskWatcher, FileExistsError, isDir, moveFile, NeedsLocationError, normalizeFileSettings, uniqueFileName, within, type FileSettings } from "./diskFolders.js";

/** How long a link the user added must stay before it grants access (#269). */
const LINK_GRANT_DELAY_MS = 60_000;

/** Page keys (scribe:some-page) mentioned anywhere in a page's state. */
function pageKeysIn(state: unknown): string[] {
  return [...JSON.stringify(state ?? {}).matchAll(/scribe:[a-z0-9._:-]+/gi)].map((m) => m[0].toLowerCase().replace(/[.:-]+$/, ""));
}

type Located = { tab: Tab; where: "open" | "closed" };

export type FolderDeleteMode = "lift" | "delete";

/** Which date the Library clean-up compares: latest activity (edit, data, or close), last edit, creation, or close. */
export type CleanupBasis = "activity" | "edited" | "created" | "closed";
export const CLEANUP_BASES: CleanupBasis[] = ["activity", "edited", "created", "closed"];

export type CleanupOptions = {
  days: number;
  basis?: CleanupBasis;
  includeOpen?: boolean;
  includePinned?: boolean;
};

const FOLDER_NAME_MAX = 120;
/** Drafts only live in memory; a window that never came back to one leaves it behind. */
const MAX_DRAFTS = 20;
/** Most JSON a page's scribe.reply may carry. */
const REPLY_DATA_MAX = 20_000;
/** Steps one drive pass takes on a page at most: a wrap-up and a start for each of a few workers. */
const MAX_DRIVE_STEPS = 20;
/** Cap so a huge HTML page cannot blow the agent context. */
const MAX_FOLDER_INSTRUCTION_CHARS = 16_000;

export class BoardStore extends EventEmitter {
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private closed = new Map<string, Tab>();
  /** New pages that are not pages yet (createDraft): not in the strip or the Library, never saved. */
  private drafts = new Map<string, Tab>();
  private folders = new Map<string, Folder>();
  private deleted: DeletedBatch[] = [];
  private activeId: string | null = null;
  private spaces: SpacesData = emptySpaces();
  private spacesDirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private trashTimer: ReturnType<typeof setInterval> | null = null;
  private assetSweepTimer: ReturnType<typeof setInterval> | null = null;
  private assetExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private assetExpiryAt = 0;
  /** Count and bytes of page assets, for pages that have any. Mirrors the page_assets table. */
  private pageAssetTotals = new Map<string, { count: number; bytes: number }>();
  private persistError: string | null = null;
  private lastStamp = 0;
  private lastSeq = 0;
  private db: BoardDb | null = null;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private foldersDirty = false;
  private templates = new Map<string, Template>();
  private builtins: Template[] = [];
  private removedTemplates = new Set<string>();
  private templatesDirty = false;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  load(): void {
    this.db = BoardDb.open(dbPath(), statePath());
    const snapshot = this.db.load();
    for (const template of snapshot.templates) {
      // Templates written for Agent Board's page API get the Scribe names. An unedited copy of a
      // built-in stays unedited, so the built-in's update still reaches it.
      const html = upgradeLegacyHtml(template.html);
      if (html !== template.html) {
        const unedited = template.source && templateFingerprint(template) === template.source.fingerprint;
        template.html = html;
        if (unedited && template.source) {
          template.source = { ...template.source, fingerprint: templateFingerprint(template) };
        }
        this.templatesDirty = true;
      }
      this.templates.set(template.id, template);
    }
    this.builtins = loadBuiltinTemplates();
    this.adoptBuiltinCopies();
    const bindings = new Map(snapshot.bindings.map((binding) => [binding.tabId, binding]));
    const batches = new Map<string, DeletedBatch>();
    const batchOf = (id: string, at: number): DeletedBatch => {
      let batch = batches.get(id);
      if (!batch) {
        batch = { id, deletedAt: at, tabs: [], folders: [] };
        batches.set(id, batch);
      }
      batch.deletedAt = Math.max(batch.deletedAt, at);
      return batch;
    };
    for (const row of snapshot.rows) {
      const tab = withStateDefaults(row.tab);
      applyBinding(tab, bindings.get(tab.id));
      // Keys from before the Scribe rename have no prefix, and old pages use Agent Board's page API.
      if (!tab.key.startsWith(PAGE_KEY_PREFIX)) {
        tab.key = pageKey(tab.key) || `${PAGE_KEY_PREFIX}${tab.id}`;
        this.markDirty(tab.id);
      }
      const upgraded = toLf(upgradeLegacyHtml(tab.html));
      if (upgraded !== tab.html) {
        tab.html = upgraded;
        this.markDirty(tab.id);
      }
      this.lastSeq = Math.max(this.lastSeq, tab.stripSeq);
      if (row.status === "open") {
        delete tab.closedAt;
        this.tabs.set(tab.id, tab);
      } else if (isAppTab(tab)) {
        this.removed.add(tab.id);
      } else if (row.status === "closed") {
        tab.closedAt = typeof tab.closedAt === "number" ? tab.closedAt : tab.updatedAt;
        this.closed.set(tab.id, tab);
      } else {
        const at = typeof row.deletedAt === "number" ? row.deletedAt : tab.updatedAt;
        batchOf(row.deletedBatch ?? tab.id, at).tabs.push(tab);
      }
    }
    for (const stored of snapshot.folders) {
      if (stored.deletedAt === undefined) {
        this.folders.set(stored.folder.id, stored.folder);
      } else {
        batchOf(stored.deletedBatch ?? stored.folder.id, stored.deletedAt).folders.push(stored.folder);
      }
    }
    this.deleted = [...batches.values()].sort((a, b) => a.deletedAt - b.deletedAt);
    this.expireTrash();
    this.trashTimer = setInterval(() => {
      if (this.expireTrash()) {
        this.persistSoon();
      }
    }, 60 * 60 * 1000);
    this.trashTimer.unref?.();
    this.repairLibraryRefs();
    this.rebuildOrder();
    this.lastStamp = Math.max(
      this.lastStamp,
      ...[...this.closed.values()].map((tab) => tab.closedAt ?? 0),
      ...this.deleted.map((batch) => batch.deletedAt)
    );
    this.activeId =
      snapshot.activeId && this.tabs.has(snapshot.activeId) ? snapshot.activeId : (this.order[0] ?? null);
    this.spaces = parseSpaces(snapshot.spaces);
    this.pageAssetTotals = this.db.pageAssetTotals();
    this.sweepAssets();
    this.assetSweepTimer = setInterval(() => this.sweepAssets(), ASSET_SWEEP_INTERVAL_MS);
    this.assetSweepTimer.unref?.();
    this.syncBuiltinCopies();
    if (this.removed.size || this.foldersDirty || this.dirty.size || this.templatesDirty) {
      this.persistSoon();
    }
  }

  snapshot(): {
    tabs: TabMeta[];
    closed: TabMeta[];
    folders: Folder[];
    activeId: string | null;
    templates: TemplateMeta[];
    builtinTemplates: BuiltinTemplateMeta[];
    persistError: string | null;
    spaces: SpacesView;
  } {
    return {
      tabs: this.order.map((id) => toMeta(this.tabs.get(id)!)),
      closed: [...this.closed.values()].sort(byLibPos).map(toMeta),
      folders: this.listFolders(),
      activeId: this.activeId,
      templates: this.listTemplates(),
      builtinTemplates: this.listBuiltinTemplates(),
      persistError: this.persistError,
      spaces: this.spacesView(),
    };
  }

  list(viewer: Viewer = "user", see?: (tab: Tab) => boolean): TabMeta[] {
    return this.listOpenTabs(viewer, see).map(toMeta);
  }

  closedCount(viewer: Viewer = "user", see?: (tab: Tab) => boolean): number {
    let count = 0;
    for (const tab of this.closed.values()) {
      if ((see ? see(tab) : visibleTo(tab, viewer)) && !isAppTab(tab)) {
        count += 1;
      }
    }
    return count;
  }

  /** see, when given, decides alone which pages show (an agent's page access, #269, which has its own take on Restricted). */
  listOpenTabs(viewer: Viewer = "user", see?: (tab: Tab) => boolean): Tab[] {
    return this.order
      .map((id) => this.tabs.get(id)!)
      .filter((tab) => tab && (see ? see(tab) : visibleTo(tab, viewer)));
  }

  listClosedTabs(viewer: Viewer = "user", see?: (tab: Tab) => boolean): Tab[] {
    return [...this.closed.values()].filter((tab) => (see ? see(tab) : visibleTo(tab, viewer)) && !isAppTab(tab)).sort(byClosedDesc);
  }

  listFolders(): Folder[] {
    return [...this.folders.values()].sort((a, b) => a.pos - b.pos);
  }

  /** Whether folderId is rootId or one of its subfolders. */
  folderInside(folderId: string, rootId: string): boolean {
    return this.folderAncestors(folderId).includes(rootId);
  }

  /** Library path like "CLIMS/Releases", or null for the root. */
  folderPath(folderId: string | undefined | null): string | null {
    const names: string[] = [];
    const seen = new Set<string>();
    let at = folderId ? this.folders.get(folderId) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      names.unshift(at.name);
      at = at.parentId ? this.folders.get(at.parentId) : undefined;
    }
    return names.length ? names.join("/") : null;
  }

  /** Existing folder for a path, without creating anything. Undefined when any part is missing. */
  findFolderPath(path: string): string | null | undefined {
    let parentId: string | null = null;
    for (const name of splitFolderPath(path)) {
      const match: Folder | undefined = this.foldersIn(parentId).find((folder) => sameName(folder.name, name));
      if (!match) {
        return undefined;
      }
      parentId = match.id;
    }
    return parentId;
  }

  /** Every folder as a path, depth-first in Library order, with its own page count (not subfolders'). */
  folderTree(viewer: Viewer = "user", see?: (tab: Tab) => boolean): Array<{ id: string; path: string; pages: number; description?: string; homeOf?: string[] }> {
    const out: Array<{ id: string; path: string; pages: number; description?: string; homeOf?: string[] }> = [];
    const walk = (parentId: string | null, prefix: string) => {
      for (const folder of this.foldersIn(parentId)) {
        const path = prefix ? `${prefix}/${folder.name}` : folder.name;
        const pages = this.pagesIn(folder.id).filter((tab) => (see ? see(tab) : visibleTo(tab, viewer))).length;
        const homeOf = this.homeOfSpaces(folder.id);
        out.push({ id: folder.id, path, pages, ...(folder.description ? { description: folder.description } : {}), ...(homeOf.length ? { homeOf } : {}) });
        walk(folder.id, path);
      }
    };
    walk(null, "");
    return out;
  }

  searchOpen(query: string, viewer: Viewer = "user", see?: (tab: Tab) => boolean): LibrarySearchResult {
    const tabs = this.listOpenTabs(viewer, see);
    return rankLibrary(tabs, query, 0, Math.max(tabs.length, 1));
  }

  /** Every page, open or closed, in Library tree order unless a query ranks them. */
  searchLibrary(
    query: string,
    opts: { offset?: number; limit?: number; folderId?: string | null; viewer?: Viewer; see?: (tab: Tab) => boolean } = {}
  ): LibrarySearchResult {
    const viewer = opts.viewer ?? "user";
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    const lim = Math.max(1, Math.floor(opts.limit ?? LIBRARY_PAGE_DEFAULT));
    let pages = this.treeOrder().filter((tab) => (opts.see ? opts.see(tab) : visibleTo(tab, viewer)));
    if (opts.folderId !== undefined) {
      const scope = opts.folderId === null ? null : this.subtreeFolderIds(opts.folderId);
      pages = pages.filter((tab) => (scope === null ? !tab.folderId : Boolean(tab.folderId && scope.has(tab.folderId))));
    }
    return rankLibrary(pages, query, off, lim);
  }

  searchPages(query: string, limit?: number, viewer: Viewer = "user", see?: (tab: Tab) => boolean): PageSearchResult {
    return rankPages(this.listOpenTabs(viewer, see), this.listClosedTabs(viewer, see), query, limit ?? PAGE_SEARCH_DEFAULT);
  }

  listTemplates(viewer: Viewer = "user"): TemplateMeta[] {
    return [...this.templates.values()]
      .sort((a, b) => a.title.localeCompare(b.title) || a.createdAt - b.createdAt)
      .map((template) => this.templateMeta(template, this.instanceCount(template.id, viewer)));
  }

  setAgentHidden(idOrKey: string, hidden: boolean): Tab {
    const tab = this.requireAny(idOrKey);
    if (Boolean(tab.agentHidden) === hidden) {
      return tab;
    }
    if (hidden) {
      tab.agentHidden = true;
    } else {
      delete tab.agentHidden;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /**
   * Links to pages the user adds by hand on a built-in template's page (a card on a board) grant the
   * page they edited access to those pages (#269), when they are Open. Only once the link has stayed
   * for LINK_GRANT_DELAY_MS, so a wrong link removed right away grants nothing. A built-in's code
   * only writes what the user does, so an agent cannot launder its own links through it.
   */
  private noteUserLinks(tab: Tab, before: BoardState, after: BoardState): void {
    const template = tab.templateId ? this.templates.get(tab.templateId) : undefined;
    if (!template?.source?.builtin) return;
    const had = new Set(pageKeysIn(before));
    for (const key of new Set(pageKeysIn(after))) {
      if (had.has(key)) continue;
      const timer = setTimeout(() => {
        const page = this.locate(tab.id)?.tab;
        const target = this.locate(key)?.tab;
        if (!page || !target || target.id === page.id || !pageKeysIn(page.state).includes(key)) return;
        if (!isOpenLevel(effectiveLevel({ ...target, createdBy: undefined }, this.accessLookup()))) return;
        this.changeAccessGrants({ kind: "page", id: page.id }, { add: [{ kind: "page", id: target.id }] });
      }, LINK_GRANT_DELAY_MS);
      timer.unref?.();
    }
  }

  /** Board lookups for agent page access (#269). */
  accessLookup(): AccessLookup {
    return {
      folderChain: (folderId) => this.folderAncestors(folderId ?? null).filter((id): id is string => Boolean(id)).reverse(),
      folderAccess: (id) => this.folders.get(id)?.access,
      pageFolder: (id) => this.locate(id)?.tab.folderId,
      pageAccess: (id) => this.locate(id)?.tab.access,
    };
  }

  /** A page's agent access level (#269). Restricted is agentHidden. Board UI only. */
  setPageAccessLevel(idOrKey: string, level: AccessLevel): Tab {
    const tab = this.requireAny(idOrKey);
    const hidden = level === "restricted";
    // Normal is the default; it is kept only to override an Open folder above (#723).
    const next = hidden ? undefined : level === "open" && inheritedFolderLevel(tab.folderId ?? null, this.accessLookup()) !== "public" ? undefined : level;
    if (Boolean(tab.agentHidden) === hidden && tab.access?.level === next) return tab;
    if (hidden) tab.agentHidden = true;
    else delete tab.agentHidden;
    tab.access = this.trimAccess({ ...(tab.access ?? {}), level: next });
    if (!tab.access) delete tab.access;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  setFolderAccessLevel(id: string, level: AccessLevel): Folder {
    const folder = this.requireFolder(id);
    const next = level === "open" && inheritedFolderLevel(folder.parentId ?? null, this.accessLookup()) !== "public" ? undefined : level;
    if (folder.access?.level === next) return folder;
    folder.access = this.trimAccess({ ...(folder.access ?? {}), level: next });
    if (!folder.access) delete folder.access;
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  /**
   * Add or remove grants on a page or folder (#269): chats on it reach those targets without asking.
   * Returns false when nothing changed.
   */
  changeAccessGrants(home: AccessTarget, change: { add?: AccessTarget[]; remove?: AccessTarget[] }): boolean {
    const edit = (grants: AccessTarget[] | undefined): AccessTarget[] | undefined => {
      let out = addTargets(grants, (change.add ?? []).filter((t) => !sameTarget(t, home)));
      for (const r of change.remove ?? []) out = out.filter((t) => !sameTarget(t, r));
      return out.length ? out : undefined;
    };
    if (home.kind === "folder") {
      const folder = this.requireFolder(home.id);
      const grants = edit(folder.access?.grants);
      if (JSON.stringify(grants ?? []) === JSON.stringify(folder.access?.grants ?? [])) return false;
      folder.access = this.trimAccess({ ...(folder.access ?? {}), grants });
      if (!folder.access) delete folder.access;
      this.foldersDirty = true;
      this.persistSoon();
      this.emitFolders();
      return true;
    }
    const tab = this.requireAny(home.id);
    const grants = edit(tab.access?.grants);
    if (JSON.stringify(grants ?? []) === JSON.stringify(tab.access?.grants ?? [])) return false;
    tab.access = this.trimAccess({ ...(tab.access ?? {}), grants });
    if (!tab.access) delete tab.access;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return true;
  }

  private trimAccess<T extends object>(access: T): T | undefined {
    const out = Object.fromEntries(Object.entries(access).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as T;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Mark (or unmark) a page as its folder's agent instructions. One flagged page per folder:
   * turning this on clears the flag on siblings. Title "Instructions" still counts without a flag.
   */
  /** The folder new chat threads on this page start in, or null for none. Board UI only. */
  setWorkspace(idOrKey: string, workspace: string | null): Tab {
    const tab = this.requireAny(idOrKey);
    const next = workspace?.trim() || undefined;
    if (tab.workspace === next) {
      return tab;
    }
    if (next) {
      tab.workspace = next;
    } else {
      delete tab.workspace;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  setFolderInstructions(id: string, description: string, instructions: string): Folder {
    const folder = this.folders.get(id);
    if (!folder) throw new Error("folder not found");
    folder.description = description.trim();
    folder.instructions = instructions.trim();
    folder.updatedAt = this.stamp();
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  /**
   * Settings for a Library folder and its parents, outermost first.
   */
  folderInstructionsFor(folderId: string | null): FolderInstruction[] {
    const out: FolderInstruction[] = [];
    for (const id of this.folderAncestors(folderId)) {
      const folder = id ? this.folders.get(id) : undefined;
      if (!folder || (!folder.description && !folder.instructions)) continue;
      const raw = folder.instructions ?? "";
      const text = raw.length > MAX_FOLDER_INSTRUCTION_CHARS
        ? `${raw.slice(0, MAX_FOLDER_INSTRUCTION_CHARS)}\n… (truncated)` : raw;
      out.push({
        folder: this.folderPath(id),
        description: folder.description,
        text,
      });
    }
    return out;
  }

  /** Template metadata, flagging a built-in's copy that fell behind its built-in. */
  templateMeta(template: Template, instanceCount = 0): TemplateMeta {
    const builtin = template.source ? this.locateBuiltin(template.source.builtin) : undefined;
    return toTemplateMeta(
      template,
      instanceCount,
      Boolean(builtin && template.source!.fingerprint !== templateFingerprint(builtin)),
      template.agentActions ?? builtin?.agentActions
    );
  }

  listBuiltinTemplates(): BuiltinTemplateMeta[] {
    return this.builtins.map((builtin) => {
      const { instanceCount: _count, builtinSource: _source, ...meta } = toTemplateMeta(builtin);
      const local = this.localCopyOf(builtin.key);
      return { ...meta, builtIn: true, ...(local ? { localId: local.id } : {}) };
    });
  }

  /**
   * The agent guide for a template: its own, or for a local copy of a built-in, the built-in's.
   * `id` names the guide across copies, so an agent is not sent the same text twice.
   */
  templateGuide(idOrKey: string): { id: string; title: string; text: string } | undefined {
    const found = this.findTemplate(idOrKey);
    if (!found) {
      return undefined;
    }
    const { template } = found;
    const builtinKey = template.source?.builtin ?? (isBuiltinId(template.id) ? template.key : undefined);
    const builtin = builtinKey ? this.locateBuiltin(builtinKey) : undefined;
    const text = template.guide || builtin?.guide;
    if (!text) {
      return undefined;
    }
    // The action list comes from the code that runs the actions, so the guide can't drift from it.
    const actions = builtinKey ? BUILTIN_ACTIONS[builtinKey] : undefined;
    const withActions = actions && text.includes("{{actions}}") ? text.replace("{{actions}}", describeActions(actions)) : text;
    const source = template.guide ? template : (builtin ?? template);
    return { id: source.id, title: source.title, text: withActions };
  }

  /** The actions a page's template provides, or undefined. */
  actionsFor(tab: Tab): ActionSet | undefined {
    if (!tab.templateId) {
      return undefined;
    }
    const template = this.templates.get(tab.templateId);
    const key = template?.source?.builtin;
    return key ? BUILTIN_ACTIONS[key] : undefined;
  }

  /** Run a template action: it reads the latest state and its ops apply all or nothing. */
  runAction(
    idOrKey: string,
    name: string,
    args: unknown,
    caller: ActionCaller,
    thread?: ActionContext["thread"],
    /** A Read-only chat's call (#719): an action that would change the page is refused. */
    readOnly = false
  ): { result: unknown; stateRevision: number; tab: Tab } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = located.tab;
    const set = this.actionsFor(tab);
    if (!set) {
      throw new Error(`${tab.key} has no actions; change its state with ops`);
    }
    const def = Object.prototype.hasOwnProperty.call(set.actions, name) ? set.actions[name] : undefined;
    if (!def) {
      throw new Error(`no action "${name}" on ${tab.key}. Actions: ${Object.keys(set.actions).join(", ")}`);
    }
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new Error("args must be an object");
    }
    const outcome = def.run(tab.state, (args ?? {}) as Record<string, unknown>, {
      caller,
      now: Date.now(),
      values: tab.templateValues ?? {},
      ...(thread ? { thread } : {}),
    });
    if (readOnly && (outcome.ops.length || outcome.events?.length)) {
      throw new Error(`"${name}" changes the page, and this thread is on the Read-only rung: it can read pages but not change them. Ask the user to move it to Board if it should.`);
    }
    if (outcome.ops.length) {
      const write = this.writeState(tab.id, { ops: outcome.ops, actor: actorFromCaller(caller), byUser: caller.by === "user" });
      if (!write.ok) {
        throw new Error("the page changed while the action ran; try again");
      }
    }
    for (const event of outcome.events ?? []) {
      this.logEvent(tab.id, { name: event.name, data: event.data, by: caller.by });
    }
    return { result: outcome.result, stateRevision: tab.stateRevision, tab };
  }

  /**
   * Point a page's scribe.reply at another page (and a card on it), or clear it with null. Agents
   * set it with page_show / page_patch; the page's own code cannot. Stored by the target's id.
   */
  setReplyTo(idOrKey: string, target: { page: string; card?: unknown } | null): Tab {
    const tab = this.requireAny(idOrKey);
    let next: ReplyTarget | undefined;
    if (target) {
      const to = this.get(target.page, "agent");
      if (!to) {
        throw new Error(`replyTo page not found: ${target.page}`);
      }
      if (to.id === tab.id) {
        throw new Error("replyTo must name another page");
      }
      next = normalizeReplyTo({ page: to.id, card: target.card });
      if (target.card !== undefined && next?.card === undefined) {
        throw new Error("replyTo card must be a card number");
      }
    }
    if (JSON.stringify(next ?? null) === JSON.stringify(tab.replyTo ?? null)) {
      return tab;
    }
    if (next) {
      tab.replyTo = next;
    } else {
      delete tab.replyTo;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /**
   * A page's scribe.reply, sent by the user's click: hand it to the page's reply target. A target
   * whose template has a reply hook (Kanban) makes its own change, and may ask for a delivery to an
   * agent chat, which the caller passes on and reports back with replyDelivered. Every other target
   * logs a `reply` event an agent can page_wait on.
   */
  receiveReply(
    idOrKey: string,
    input: { summary?: unknown; data?: unknown },
    thread?: ActionContext["thread"]
  ): { target: Tab; result: unknown; deliver?: ReplyDelivery } {
    const source = this.requireAny(idOrKey);
    if (!source.replyTo) {
      throw new Error("This page has no reply target. The agent that made it sets one with page_show replyTo.");
    }
    const target = this.locate(source.replyTo.page)?.tab;
    if (!target) {
      throw new Error("The page this one replies to is gone");
    }
    if (input.data !== undefined && !isPlainObject(input.data)) {
      throw new Error("reply data must be an object");
    }
    const data = (input.data ?? {}) as Record<string, unknown>;
    if (JSON.stringify(data).length > REPLY_DATA_MAX) {
      throw new Error(`reply data is over ${REPLY_DATA_MAX / 1000} KB`);
    }
    const summary = typeof input.summary === "string" ? input.summary.trim().replace(/\s+/g, " ").slice(0, 300) : "";
    const reply: InboundReply = {
      from: { id: source.id, key: source.key, title: source.title },
      ...(source.replyTo.card !== undefined ? { card: source.replyTo.card } : {}),
      summary,
      data,
    };
    const set = this.actionsFor(target);
    if (!set?.reply) {
      this.logEvent(target.id, { name: "reply", data: reply, by: "user" });
      return { target, result: { event: "reply" } };
    }
    const outcome = set.reply(target.state, reply, this.replyContext(target, thread));
    this.applyOutcome(target, outcome);
    return { target, result: outcome.result, ...(outcome.deliver ? { deliver: outcome.deliver } : {}) };
  }

  /** How a reply's delivery to an agent chat went, for the target's template to record. */
  replyDelivered(
    targetId: string,
    deliver: ReplyDelivery,
    delivered: "steered" | "queued" | "started" | null,
    thread?: ActionContext["thread"]
  ): void {
    const target = this.locate(targetId)?.tab;
    const set = target ? this.actionsFor(target) : undefined;
    if (!target || !set?.replyDelivered) {
      return;
    }
    const outcome = set.replyDelivered(target.state, deliver, delivered, this.replyContext(target, thread));
    if (outcome) {
      this.applyOutcome(target, outcome);
    }
  }

  private replyContext(target: Tab, thread?: ActionContext["thread"]): ActionContext {
    return { caller: { by: "user", label: "reply" }, now: Date.now(), values: target.templateValues ?? {}, ...(thread ? { thread } : {}) };
  }

  private applyOutcome(tab: Tab, outcome: { ops: unknown[]; events?: Array<{ name: string; data?: unknown }> }): void {
    if (outcome.ops.length) {
      const write = this.writeState(tab.id, { ops: outcome.ops });
      if (!write.ok) {
        throw new Error("the page changed while the reply was handled; try again");
      }
    }
    for (const event of outcome.events ?? []) {
      this.logEvent(tab.id, { name: event.name, data: event.data, by: "user" });
    }
  }

  /** Let each page's actions tidy up after agents that stopped (stale claims). */
  sweepActions(ctx: SweepContext): void {
    for (const tab of [...this.tabs.values(), ...this.closed.values()]) {
      const set = this.actionsFor(tab);
      if (!set?.sweep) {
        continue;
      }
      try {
        const outcome = set.sweep(tab.state, ctx);
        if (!outcome) {
          continue;
        }
        if (outcome.ops.length) {
          this.writeState(tab.id, { ops: outcome.ops, lenient: true });
        }
        for (const event of outcome.events ?? []) {
          this.logEvent(tab.id, { name: event.name, data: event.data, by: "scribe" });
        }
      } catch (err) {
        log(`Action sweep failed on ${tab.key}`, String(err));
      }
    }
  }

  /**
   * Let each page's actions drive its own agents (a Kanban board's workers), with or without a
   * window on it: step until there is none left. A step's launch goes to `launch`, and its result
   * back to the page's launched hook.
   */
  driveActions(ctx: Omit<DriveContext, "page" | "mayStart">, launch: (pageId: string, launch: PageLaunch, validate: () => void) => Promise<string>): void {
    for (const tab of [...this.tabs.values(), ...this.closed.values()]) {
      const set = this.actionsFor(tab);
      if (!set?.drive) continue;
      const page = { id: tab.id, title: tab.title };
      const mayStart = (settings: LaunchSettings) => this.mayStartAgent(tab.id, settings);
      // A step changes the state it reads, so the next one sees it; a few cover every worker of a board.
      for (let i = 0; i < MAX_DRIVE_STEPS; i++) {
        try {
          const outcome = set.drive(tab.state, { ...ctx, page, mayStart });
          if (!outcome) break;
          const write = outcome.ops.length ? this.writeState(tab.id, { ops: outcome.ops, lenient: true }) : null;
          for (const event of outcome.events ?? []) this.logEvent(tab.id, { name: event.name, data: event.data, by: "scribe" });
          if (outcome.launch) this.launchFor(tab.id, outcome.launch, launch);
          else if (!write?.ok || !write.applied.length) break;
        } catch (err) {
          log(`Action drive failed on ${tab.key}`, String(err));
          break;
        }
      }
    }
  }

  /** Whether the page's actions drive agents of its own (driveActions). */
  drives(tab: Tab): boolean {
    return Boolean(this.actionsFor(tab)?.drive);
  }

  private launchFor(pageId: string, item: PageLaunch, launch: (pageId: string, launch: PageLaunch, validate: () => void) => Promise<string>): void {
    const validate = () => {
      const current = this.locate(pageId)?.tab;
      const set = current ? this.actionsFor(current) : undefined;
      if (!current || this.mayStartAgent(pageId, item.settings) || set?.launchAllowed?.(current.state, item, Date.now()) === false) {
        throw new Error("Worker conditions changed before dispatch; continuation remains pending.");
      }
    };
    void launch(pageId, item, validate)
      .then((threadId) => ({ threadId }), (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
      .then((result) => {
        const tab = this.locate(pageId)?.tab;
        const set = tab ? this.actionsFor(tab) : undefined;
        if (!tab || !set?.launched) return;
        try {
          const outcome = set.launched(tab.state, item, result, Date.now());
          if (outcome?.ops.length) this.writeState(tab.id, { ops: outcome.ops, lenient: true });
        } catch (err) {
          log(`Recording a launch failed on ${tab.key}`, String(err));
        }
      });
  }

  /** Why a page may not start this agent chat without a click (its permissions), or null. */
  mayStartAgent(pageId: string, settings: LaunchSettings): string | null {
    const grants = this.pagePermissions(pageId);
    const allowed = (need: PermissionNeed) => checkPermission(grants, need) === "allow";
    if (!allowed({ perm: "agent.chat" }) || !allowed({ perm: "agent.unattended" })) {
      return "Scribe needs this board's permission to start agent chats on its own: press ▶ to allow it (or tab menu → Permissions…: Agent chats without a click).";
    }
    if (settings.cwd && !allowed({ perm: "agent.workspace", folder: settings.cwd, approval: settings.approval })) {
      return `Scribe needs this board's permission to start agent chats in ${settings.cwd} at ${settings.approval}: press ▶ to allow it (or tab menu → Permissions…).`;
    }
    return null;
  }

  /** A page's reason to keep a finished run's branch unmerged (see ActionSet.runHold), or null. */
  runHold(pageId: string, threadId: string): string | null {
    const tab = this.locate(pageId)?.tab;
    const set = tab ? this.actionsFor(tab) : undefined;
    if (!tab || !set?.runHold) return null;
    try {
      return set.runHold(tab.state, threadId);
    } catch (err) {
      log(`Run hold check failed on ${tab.key}`, String(err));
      return null;
    }
  }

  /**
   * Scribe moved one of a page's runs on: log an agent_run event on the page (agents and pages can
   * wait on it) and let the page's actions record it (a Kanban board's worker log).
   */
  runEvent(pageId: string, threadId: string, run: RunEvent["run"], note: RunNote): void {
    const tab = this.locate(pageId)?.tab;
    if (!tab) return;
    const event: RunEvent = { ...note, thread: threadId, run };
    try {
      const set = this.actionsFor(tab);
      const outcome = set?.runEvent?.(tab.state, event, Date.now());
      if (outcome?.ops.length) this.writeState(tab.id, { ops: outcome.ops, lenient: true });
      for (const extra of outcome?.events ?? []) this.logEvent(tab.id, { name: extra.name, data: extra.data, by: "scribe" });
      this.logEvent(tab.id, {
        name: "agent_run",
        data: { thread: threadId, kind: note.kind, text: note.text, ...(run.tag ? { tag: run.tag } : {}), ...(run.data ? { data: run.data } : {}), phase: run.phase, ...(run.outcome ? { outcome: run.outcome } : {}) },
        by: "scribe",
      });
    } catch (err) {
      log(`Run event failed on ${tab.key}`, String(err));
    }
  }

  searchDeclaration(tab: Tab): Template["search"] {
    const template = tab.templateId ? this.getTemplate(tab.templateId) : undefined;
    return template?.search ?? (template?.source ? this.findTemplate("builtin:" + template.source.builtin)?.template.search : undefined);
  }

  /** The user's own templates only. findTemplate also looks at built-ins. */
  getTemplate(idOrKey: string): Template | undefined {
    return this.locateTemplate(idOrKey);
  }

  /** A local template first, then a built-in by id or key. */
  findTemplate(idOrKey: string): { template: Template; builtIn: boolean } | undefined {
    const local = isBuiltinId(idOrKey) ? undefined : this.locateTemplate(idOrKey);
    if (local) {
      return { template: local, builtIn: false };
    }
    const builtin = this.locateBuiltin(idOrKey);
    return builtin ? { template: builtin, builtIn: true } : undefined;
  }

  /**
   * The local copy of a built-in, created on first use. An app update only changes it while it is
   * unedited and the state format is unchanged (see syncBuiltinCopies). The copy is found again by
   * its source, even after it has been edited.
   */
  copyBuiltinTemplate(idOrKey: string): { template: Template; created: boolean } {
    const builtin = this.locateBuiltin(idOrKey);
    if (!builtin) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    const existing = this.localCopyOf(builtin.key);
    if (existing) {
      return { template: existing, created: false };
    }
    const id = newTemplateId();
    const now = Date.now();
    // The guide and agent actions stay with the built-in, so an app update reaches copies made before it.
    const { guide: _guide, agentActions: _actions, ...content } = structuredClone(builtin);
    const template: Template = {
      ...content,
      id,
      key: uniqueTemplateKey(this, builtin.key, builtin.title, id),
      createdAt: now,
      updatedAt: now,
      source: { builtin: builtin.key, fingerprint: templateFingerprint(builtin) },
    };
    this.templates.set(id, template);
    this.markTemplateDirty(id);
    this.persistSoon();
    this.emit("template_upserted", this.templateMeta(template, 0));
    this.emit("builtin_templates", this.listBuiltinTemplates());
    return { template, created: true };
  }

  upsertTemplate(input: TemplateUpsertInput): { template: Template; created: boolean } {
    if (input.id && isBuiltinId(input.id)) {
      throw new Error("built-in templates are read-only. Open it once to get a local copy, then update that copy by its key.");
    }
    const parsed = normalizeTemplateInput(input);
    const existing = input.id
      ? this.locateTemplate(input.id)
      : input.key
        ? this.locateTemplate(input.key)
        : undefined;
    const now = Date.now();
    if (existing) {
      const prevVersion = existing.stateVersion;
      existing.title = parsed.title;
      existing.description = parsed.description;
      existing.html = parsed.html;
      existing.fields = parsed.fields;
      existing.titleTemplate = parsed.titleTemplate;
      existing.initialState = parsed.initialState;
      if (parsed.guide !== undefined) {
        if (parsed.guide) {
          existing.guide = parsed.guide;
        } else {
          delete existing.guide;
        }
      }
      if (input.search !== undefined) existing.search = parsed.search;
      if (parsed.pin === false) {
        existing.pin = false;
      } else if (parsed.pin) {
        delete existing.pin;
      }
      if (parsed.agentActions !== undefined) {
        if (parsed.agentActions.length) {
          existing.agentActions = parsed.agentActions;
        } else {
          delete existing.agentActions;
        }
      }
      if (parsed.stateVersion !== undefined) {
        existing.stateVersion = parsed.stateVersion;
      }
      const builtin = existing.source ? this.locateBuiltin(existing.source.builtin) : undefined;
      if (builtin && (input.syncedWithBuiltin || templateFingerprint(existing) === templateFingerprint(builtin))) {
        existing.source = { builtin: builtin.key, fingerprint: templateFingerprint(builtin) };
      }
      existing.updatedAt = now;
      this.markTemplateDirty(existing.id);
      this.refreshTemplateInstances(existing, parsed.stateVersion !== undefined && parsed.stateVersion !== prevVersion);
      this.persistSoon();
      this.emit("template_upserted", this.templateMeta(existing, this.instanceCount(existing.id)));
      return { template: existing, created: false };
    }
    const id = newTemplateId();
    const template: Template = {
      id,
      key: uniqueTemplateKey(this, input.key, parsed.title, id),
      title: parsed.title,
      description: parsed.description,
      html: parsed.html,
      fields: parsed.fields,
      ...(parsed.titleTemplate ? { titleTemplate: parsed.titleTemplate } : {}),
      ...(parsed.initialState ? { initialState: parsed.initialState } : {}),
      stateVersion: parsed.stateVersion ?? 1,
      ...(parsed.guide ? { guide: parsed.guide } : {}),
      ...(parsed.agentActions?.length ? { agentActions: parsed.agentActions } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.pin === false ? { pin: false as const } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(id, template);
    this.markTemplateDirty(id);
    this.persistSoon();
    this.emit("template_upserted", this.templateMeta(template, 0));
    return { template, created: true };
  }

  deleteTemplate(idOrKey: string): Template {
    const template = isBuiltinId(idOrKey) ? undefined : this.locateTemplate(idOrKey);
    if (!template) {
      if (this.locateBuiltin(idOrKey)) {
        throw new Error("built-in templates cannot be deleted");
      }
      throw new Error(`template not found: ${idOrKey}`);
    }
    for (const tab of this.allTabs()) {
      if (tab.templateId === template.id) {
        this.unlinkTemplate(tab);
      }
    }
    this.templates.delete(template.id);
    this.removedTemplates.add(template.id);
    this.templatesDirty = true;
    this.persistSoon();
    this.emit("template_deleted", template.id);
    if (template.source) {
      this.emit("builtin_templates", this.listBuiltinTemplates());
    }
    return template;
  }

  /** into: a blank page or draft that becomes the new page, in its place in the strip. */
  openFromTemplate(
    idOrKey: string,
    values: unknown,
    opts?: { activate?: boolean; agentHidden?: boolean; actor?: PageActor; into?: string }
  ): { tab: Tab; created: boolean; template: Template; copiedBuiltin: boolean } {
    const found = this.findTemplate(idOrKey);
    if (!found) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    if (opts?.into && !this.blankOf(opts.into)) {
      throw new Error("this page is not blank anymore");
    }
    // Validate against the built-in first so a bad form doesn't leave a stray copy behind.
    parseTemplateValues(found.template.fields, values);
    const copy = found.builtIn ? this.copyBuiltinTemplate(found.template.id) : undefined;
    const template = copy ? copy.template : found.template;
    const parsed = parseTemplateValues(template.fields, values);
    const title = renderTemplateTitle(template, parsed);
    const html = this.renderBoundHtml(template, title, parsed);
    const initialState = structuredClone(template.initialState ?? {});
    const actionSet = template.source?.builtin ? BUILTIN_ACTIONS[template.source.builtin] : undefined;
    const state = actionSet?.seed ? actionSet.seed(initialState, parsed) : initialState;
    const pin = template.pin !== false;
    const tab = opts?.into
      ? this.fillBlank(this.openBlank(opts.into), { title, html, pin, state, actor: opts.actor })
      : this.upsert({
          title,
          html,
          pin,
          activate: opts?.activate !== false,
          state,
          actor: opts?.actor,
        }).tab;
    if (opts?.agentHidden) {
      tab.agentHidden = true;
    }
    this.bindTab(tab, template, parsed, true);
    this.markDirty(tab.id);
    this.persistSoon();
    const index = this.order.indexOf(tab.id);
    this.emit("tab_upserted", toMeta(tab), index === -1 ? undefined : index, {
      activate: opts?.activate !== false,
      structural: true,
    });
    return { tab, created: true, template, copiedBuiltin: Boolean(copy?.created) };
  }

  /**
   * A page the user just opened with New page (Ctrl+T). It has no tab, no Library row, and is not
   * saved until a chat thread starts on it or a template fills it (promoteDraft, openFromTemplate).
   * Passing the id of one the daemon lost (a restart) brings it back under the same id.
   */
  createDraft(id?: string): Tab {
    const known = id ? this.drafts.get(id) ?? this.locate(id)?.tab : undefined;
    if (known) {
      return known;
    }
    const draftId = id && /^t_[0-9a-f]{8}$/.test(id) ? id : newId();
    const now = Date.now();
    const tab: Tab = {
      id: draftId,
      key: uniqueKey(this, undefined, NEW_PAGE_TITLE, draftId),
      title: NEW_PAGE_TITLE,
      html: "",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      libPos: 0,
      stripSeq: 0,
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      eventSeq: 0,
      events: [],
      assets: [],
    };
    this.drafts.set(draftId, tab);
    while (this.drafts.size > MAX_DRAFTS) {
      this.drafts.delete(this.drafts.keys().next().value!);
    }
    return tab;
  }

  isDraft(id: string): boolean {
    return this.drafts.has(id);
  }

  getDraft(id: string): Tab | undefined {
    return this.drafts.get(id);
  }

  discardDraft(id: string): boolean {
    return this.drafts.delete(id);
  }

  /** A draft becomes a real, blank page at the end of the strip. Anything else is left alone. */
  promoteDraft(id: string, opts: { activate?: boolean } = {}): Tab | undefined {
    const tab = this.drafts.get(id);
    if (!tab) {
      return undefined;
    }
    this.drafts.delete(id);
    const now = Date.now();
    tab.createdAt = now;
    tab.updatedAt = now;
    this.placeNew(tab);
    tab.libPos = this.pagePosAt(tab.folderId ?? null, 0);
    return this.reopen(tab, "append", opts.activate !== false);
  }

  /** The draft or saved page with this id, while it is still blank. */
  private blankOf(id: string): Tab | undefined {
    const tab = this.drafts.get(id) ?? this.locate(id)?.tab;
    return tab && isBlankPage(tab) ? tab : undefined;
  }

  /** A blank page in the strip and focused, made real first if it is still a draft. */
  private openBlank(id: string): Tab {
    if (this.drafts.has(id)) {
      return this.promoteDraft(id)!;
    }
    const located = this.locate(id);
    if (!located || !isBlankPage(located.tab)) {
      throw new Error("this page is not blank anymore");
    }
    if (located.where === "closed") {
      return this.restore(located.tab.id, { placement: "append", activate: true });
    }
    this.activeId = located.tab.id;
    return located.tab;
  }

  /**
   * A new page written into a blank one: it takes the blank page's id, so the chat thread that
   * belongs to that page stays with what it made. Callers emit the upsert.
   */
  private fillBlank(
    tab: Tab,
    input: Pick<UpsertInput, "key" | "pin" | "state" | "assets" | "folder" | "actor"> & { title: string; html: string }
  ): Tab {
    tab.assets = applyAssets(tab.id, tab.assets ?? [], input.assets);
    tab.key = uniqueKey(this, input.key, input.title, tab.id);
    tab.title = input.title;
    tab.html = input.html;
    tab.createdAt = Date.now();
    tab.updatedAt = tab.createdAt;
    tab.revision += 1;
    seedState(tab, input.state);
    if (input.folder && (!tab.folderId || tab.folderId === this.spaceHome(tab.madeIn))) {
      const foldersBefore = this.folders.size;
      const folderId = this.ensureFolderPath(input.folder);
      if (folderId) {
        tab.folderId = folderId;
        tab.libPos = this.pagePosAt(folderId, 0, tab.id);
      }
      if (this.folders.size !== foldersBefore) {
        this.emitFolders();
      }
    }
    if (input.pin !== undefined && tab.pinned !== input.pin) {
      this.setPinned(tab, input.pin);
    }
    noteAgentWrite(tab, input.actor, true);
    this.activeId = tab.id;
    this.markDirty(tab.id);
    this.persistSoon();
    return tab;
  }

  setTemplateValues(idOrKey: string, values: unknown, actor?: PageActor): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const template = this.requireTemplate(tab.templateId);
    const parsed = parseTemplateValues(template.fields, values);
    this.applyTemplateRender(tab, template, parsed, tab.templateCompatible !== false);
    noteAgentWrite(tab, actor);
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, {
      activate: false,
      structural: true,
    });
    return tab;
  }

  reportIncompatible(idOrKey: string, reason?: string): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const message = (reason ?? "").trim() || "This page's data no longer matches the template.";
    if (tab.templateCompatible === false && tab.templateIncompatibleReason === message) {
      return tab;
    }
    tab.templateCompatible = false;
    tab.templateIncompatibleReason = message;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, {
      activate: false,
      structural: false,
    });
    return tab;
  }

  /** One template, one page, folder subtrees, a mixed selection, or the whole Library. */
  exportFile(scope: { templateId?: string; id?: string; folderId?: string; pageIds?: string[]; folderIds?: string[] } = {}): BoardExportFile {
    if (scope.templateId) {
      return buildExport([], [this.requireTemplate(scope.templateId)]);
    }
    let tabs: Tab[];
    const selection = scope.pageIds !== undefined || scope.folderIds !== undefined;
    const selectedFolders = new Set<string>();
    if (selection) {
      const pageIds = new Set((scope.pageIds || []).map((id) => this.requireAny(id).id));
      for (const id of scope.folderIds || []) {
        if (!this.folders.has(id)) throw new Error(`folder not found: ${id}`);
        for (const child of this.subtreeFolderIds(id)) selectedFolders.add(child);
      }
      tabs = this.treeOrder().filter((tab) => pageIds.has(tab.id) || (tab.folderId && selectedFolders.has(tab.folderId)));
    } else if (scope.id) {
      tabs = [this.requireAny(scope.id)];
    } else if (scope.folderId) {
      if (!this.folders.has(scope.folderId)) {
        throw new Error(`folder not found: ${scope.folderId}`);
      }
      const ids = this.subtreeFolderIds(scope.folderId);
      tabs = this.treeOrder().filter((tab) => tab.folderId && ids.has(tab.folderId));
    } else {
      tabs = this.treeOrder();
    }
    const templates = scope.id || scope.folderId || selection
      ? [...new Set(tabs.map((tab) => tab.templateId).filter((id): id is string => Boolean(id)))]
          .map((id) => this.templates.get(id))
          .filter((template): template is Template => Boolean(template))
      : [...this.templates.values()];
    const folders = scope.id ? [] : this.listFolders().filter((folder) =>
      selection ? selectedFolders.has(folder.id) : !scope.folderId || this.folderInside(folder.id, scope.folderId)).map((folder) => ({
        path: this.folderPath(folder.id)!,
        ...(folder.description ? { description: folder.description } : {}),
        ...(folder.instructions ? { instructions: folder.instructions } : {}),
      }));
    if (!tabs.length && !templates.length && !folders.length) {
      throw new Error("nothing to export");
    }
    const file = buildExport(
      tabs.map((tab) => ({
        tab,
        assets: readPreparedAssets(tab.id, tab.assets ?? []),
        pageAssets: this.pageAssetTotals.has(tab.id) ? this.requireDb().readPageAssetDrafts(tab.id) : [],
        folderPath: this.folderPath(tab.folderId),
      })),
      templates
    );
    if (folders.length) file.folders = folders;
    return file;
  }

  /** Templates are matched by content, so importing the same file twice links to the templates created the first time. */
  importBoard(
    input: { templates: Template[]; pages: ImportPageInput[]; folders?: BoardExportFolder[] },
    destination: ImportDestination
  ): {
    tabs: Tab[];
    opened: number;
    closed: number;
    focusedId: string | null;
    templatesCreated: number;
    templatesReused: number;
  } {
    // Exports from Agent Board carry pages and templates written for its page API.
    const pages = input.pages.map((page) => ({ ...page, html: upgradeLegacyHtml(page.html) }));
    const templates = input.templates.map((template) => ({ ...template, html: upgradeLegacyHtml(template.html) }));
    if (!pages.length && !templates.length && !input.folders?.length) {
      throw new Error("nothing to import");
    }
    const plan = this.planTemplateImport(templates);
    const drafts: Tab[] = [];
    const reserved = new Set<string>();
    const pendingAssets = new Map<string, PageAssetDraft[]>();
    try {
      for (const page of pages) {
        const tab = this.buildImportedDraft(page, reserved, plan.byFileId, pendingAssets);
        reserved.add(tab.key);
        drafts.push(tab);
      }
    } catch (err) {
      for (const tab of drafts) {
        deleteTabAssets(tab.id);
      }
      throw err;
    }

    for (const template of plan.created) {
      this.templates.set(template.id, template);
      this.markTemplateDirty(template.id);
    }
    const foldersBefore = this.folders.size;
    for (const settings of input.folders ?? []) {
      const id = this.ensureFolderPath(settings.path);
      if (id) {
        const folder = this.folders.get(id)!;
        if (settings.description !== undefined) folder.description = settings.description.trim();
        if (settings.instructions !== undefined) folder.instructions = settings.instructions.trim();
        this.foldersDirty = true;
      }
    }
    this.placeImported(drafts, pages);
    const opened: Tab[] = [];
    const closed: Tab[] = [];
    for (let i = 0; i < drafts.length; i += 1) {
      const tab = drafts[i];
      const page = pages[i];
      if (shouldClose(destination, page.closedAt)) {
        tab.closedAt = typeof page.closedAt === "number" ? page.closedAt : this.stamp();
        this.closed.set(tab.id, tab);
        closed.push(tab);
      } else {
        this.tabs.set(tab.id, tab);
        opened.push(tab);
      }
      this.markDirty(tab.id);
    }
    this.rebuildOrder();
    const focused = opened[opened.length - 1];
    if (focused) {
      this.activeId = focused.id;
    }
    if (pendingAssets.size) {
      this.insertImportedPageAssets(pendingAssets);
    } else {
      this.persistSoon();
    }
    if (this.folders.size !== foldersBefore || input.folders?.length) {
      this.emitFolders();
    }
    for (const tab of closed) {
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    }
    for (let i = 0; i < opened.length; i += 1) {
      const tab = opened[i];
      const last = i === opened.length - 1;
      this.emit("tab_upserted", toMeta(tab), this.order.indexOf(tab.id), {
        activate: last,
        structural: true,
      });
    }
    if (focused) {
      this.emit("tab_focused", focused.id);
    }
    if (plan.created.some((template) => template.source)) {
      this.emit("builtin_templates", this.listBuiltinTemplates());
    }
    for (const template of new Set(plan.byFileId.values())) {
      this.emit("template_upserted", this.templateMeta(template, this.instanceCount(template.id)));
    }
    return {
      tabs: drafts,
      opened: opened.length,
      closed: closed.length,
      focusedId: focused?.id ?? null,
      templatesCreated: plan.created.length,
      templatesReused: plan.reused,
    };
  }

  getActiveId(viewer: Viewer = "user"): string | null {
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
    return active && visibleTo(active, viewer) ? active.id : null;
  }

  get(idOrKey: string, viewer: Viewer = "user"): Tab | undefined {
    const tab = this.locate(idOrKey)?.tab;
    return tab && visibleTo(tab, viewer) ? tab : undefined;
  }

  isClosed(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "closed";
  }

  isOpen(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "open";
  }

  upsert(input: UpsertInput): { tab: Tab; created: boolean; closed: boolean; titleKept?: string } {
    const requestedTitle = input.title.trim();
    if (!requestedTitle) {
      throw new Error("title is required");
    }
    if (!input.html || !input.html.trim()) {
      throw new Error("html is required");
    }

    const viewer = input.viewer ?? "user";
    const existing = input.key ? this.locateFor(input.key, viewer) : undefined;
    if (existing && isTemplateBound(existing.tab)) {
      throw new Error(boundHtmlError(existing.tab, this.templateLabel(existing.tab)));
    }
    if (existing?.tab.file) {
      throw new Error(`${existing.tab.key} is a file page (${existing.tab.file.path}); its HTML comes from Scribe. Edit the file instead.`);
    }
    if (existing) {
      this.assertTabRevision(existing.tab, input.expectedRevision);
    }
    const kept = existing ? this.heldTitle(existing.tab, requestedTitle, viewer) : undefined;
    const title = kept ? existing!.tab.title : requestedTitle;
    const html = wrapHtml(title, input.html);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    if (!existing && input.into && input.activate !== false && this.blankOf(input.into)) {
      const tab = this.fillBlank(this.openBlank(input.into), { ...input, title, html });
      this.emit("tab_upserted", toMeta(tab), this.order.indexOf(tab.id), actorNotice(true, true, input.actor));
      this.emit("tab_focused", tab.id);
      return { tab, created: true, closed: false };
    }
    if (existing?.where === "closed" && input.activate !== false) {
      this.restore(existing.tab.id, { placement: "append", activate: true });
    }

    const located = input.key ? this.locateFor(input.key, viewer) : undefined;
    const now = Date.now();
    if (located?.where === "closed") {
      const tab = located.tab;
      tab.assets = applyAssets(tab.id, tab.assets ?? [], input.assets);
      tab.title = title;
      tab.html = html;
      tab.updatedAt = now;
      tab.revision += 1;
      seedState(tab, input.state);
      if (input.pin !== undefined) {
        tab.pinned = input.pin && !tab.temp;
      }
      noteAgentWrite(tab, input.actor);
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, {
        activate: false,
        structural: true,
      });
      return { tab, created: false, closed: true, ...(kept ? { titleKept: kept } : {}) };
    }

    if (located?.where === "open") {
      const tab = located.tab;
      tab.assets = applyAssets(tab.id, tab.assets ?? [], input.assets);
      tab.title = title;
      tab.html = html;
      tab.updatedAt = now;
      tab.revision += 1;
      seedState(tab, input.state);
      let pinIndex: number | undefined;
      if (input.pin !== undefined && tab.pinned !== input.pin) {
        this.setPinned(tab, input.pin);
        pinIndex = this.order.indexOf(tab.id);
      } else if (input.pin !== undefined) {
        tab.pinned = input.pin && !tab.temp;
      }
      if (input.activate !== false) {
        this.activeId = tab.id;
      }
      noteAgentWrite(tab, input.actor);
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), pinIndex, actorNotice(input.activate !== false, true, input.actor));
      if (input.activate !== false) {
        this.emit("tab_focused", tab.id);
      }
      return { tab, created: false, closed: false, ...(kept ? { titleKept: kept } : {}) };
    }

    const id = newId();
    let assets: TabAsset[] = [];
    try {
      assets = applyAssets(id, [], input.assets);
    } catch (err) {
      deleteTabAssets(id);
      throw err;
    }
    const foldersBefore = this.folders.size;
    const madeIn = this.newPageSpace(input.actor);
    const home = input.temp ? undefined : this.spaceHome(madeIn);
    const folderId = input.folder ? this.ensureFolderPath(input.folder) : home && (input.homeFits?.(home) ?? true) ? home : null;
    const tab: Tab = {
      id,
      key: uniqueKey(this, input.key, title, id),
      title,
      html,
      pinned: Boolean(input.pin) && !input.temp,
      ...(input.temp ? { temp: true } : {}),
      createdAt: now,
      updatedAt: now,
      ...(folderId ? { folderId } : {}),
      ...(madeIn ? { madeIn } : {}),
      libPos: this.pagePosAt(folderId, 0),
      stripSeq: this.nextSeq(),
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      eventSeq: 0,
      events: [],
      assets,
    };
    seedState(tab, input.state);
    noteAgentWrite(tab, input.actor, true);
    const activate = input.activate !== false;
    if (activate) {
      this.tabs.set(id, tab);
      this.rebuildOrder();
      this.activeId = id;
    } else {
      // background create: Library only. A new unfocused tab still clutters the strip.
      tab.closedAt = this.stamp();
      this.closed.set(id, tab);
    }
    this.markDirty(id);
    this.persistSoon();
    if (this.folders.size !== foldersBefore) {
      this.emitFolders();
    }
    this.emit("tab_upserted", toMeta(tab), activate ? this.order.indexOf(id) : undefined, actorNotice(activate, true, input.actor));
    if (activate) {
      this.emit("tab_focused", id);
    }
    return { tab, created: true, closed: !activate };
  }

  patchHtml(
    idOrKey: string,
    input: {
      edits?: HtmlEdit[];
      /** Replaces the whole body, e.g. a checked-out file. Mutually exclusive with edits. */
      html?: string;
      title?: string;
      activate?: boolean;
      expectedRevision?: number;
      viewer?: Viewer;
      actor?: PageActor;
    }
  ): { tab: Tab; applied: number; closed: boolean; titleKept?: string } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isTemplateBound(located.tab)) {
      throw new Error(boundHtmlError(located.tab, this.templateLabel(located.tab)));
    }
    this.assertTabRevision(located.tab, input.expectedRevision);
    let nextTitle = located.tab.title;
    let kept: string | undefined;
    if (input.title !== undefined) {
      const requested = input.title.trim();
      if (!requested) {
        throw new Error("title is required");
      }
      kept = this.heldTitle(located.tab, requested, input.viewer ?? "user");
      nextTitle = kept ? located.tab.title : requested;
    }
    const result = replaceOrEdit(located.tab, input);
    const bytes = Buffer.byteLength(result.html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    const keptField = kept ? { titleKept: kept } : {};

    const htmlChanged = result.html !== located.tab.html;
    const titleChanged = nextTitle !== located.tab.title;
    if (!htmlChanged && !titleChanged) {
      return {
        tab: located.tab,
        applied: result.applied,
        closed: located.where === "closed",
        ...keptField,
      };
    }

    if (located.where === "closed" && input.activate !== false) {
      this.restore(located.tab.id, { placement: "append", activate: true });
    }
    const found = this.locate(idOrKey);
    if (!found) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = found.tab;
    tab.title = nextTitle;
    tab.html = result.html;
    tab.updatedAt = Date.now();
    tab.revision += 1;
    noteAgentWrite(tab, input.actor);
    if (found.where === "closed") {
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
      return { tab, applied: result.applied, closed: true, ...keptField };
    }
    if (input.activate !== false) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, actorNotice(input.activate !== false, true, input.actor));
    if (input.activate !== false) {
      this.emit("tab_focused", tab.id);
    }
    return { tab, applied: result.applied, closed: false, ...keptField };
  }

  update(
    idOrKey: string,
    patch: {
      title?: string;
      html?: string;
      pin?: boolean;
      activate?: boolean;
      expectedRevision?: number;
      viewer?: Viewer;
      actor?: PageActor;
    }
  ): { tab: Tab; titleKept?: string } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    this.assertTabRevision(located.tab, patch.expectedRevision);
    let title: string | undefined;
    let kept: string | undefined;
    if (patch.title !== undefined) {
      const requested = patch.title.trim();
      if (!requested) {
        throw new Error("title is required");
      }
      kept = this.heldTitle(located.tab, requested, patch.viewer ?? "user");
      title = kept ? undefined : requested;
    }
    const structural = title !== undefined || patch.html !== undefined;
    if (located.where === "closed" && patch.activate !== false && structural) {
      this.restore(located.tab.id, { placement: "append", activate: true });
    }
    const found = this.locate(idOrKey);
    if (!found) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = found.tab;
    let pinIndex: number | undefined;
    if (title !== undefined) {
      tab.title = title;
    }
    if (patch.html !== undefined) {
      if (isTemplateBound(tab)) {
        throw new Error(boundHtmlError(tab, this.templateLabel(tab)));
      }
      if (!patch.html.trim()) {
        throw new Error("html is required");
      }
      tab.html = wrapHtml(tab.title, patch.html);
      const bytes = Buffer.byteLength(tab.html, "utf8");
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
      }
    }
    if (patch.pin === true && tab.temp) {
      throw new Error(`${tab.key} is a temporary page and can't be pinned; keep it in the Library first`);
    }
    if (patch.pin !== undefined && found.where === "open" && tab.pinned !== patch.pin) {
      this.setPinned(tab, patch.pin);
      pinIndex = this.order.indexOf(tab.id);
    } else if (patch.pin !== undefined) {
      tab.pinned = patch.pin;
    }
    if (structural) {
      tab.updatedAt = Date.now();
      tab.revision += 1;
      noteAgentWrite(tab, patch.actor);
    }
    const keptField = kept ? { titleKept: kept } : {};
    if (found.where === "closed") {
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural });
      return { tab, ...keptField };
    }
    if (patch.activate !== false && structural) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), pinIndex, actorNotice(patch.activate !== false, structural, patch.actor));
    if (patch.activate !== false && structural) {
      this.emit("tab_focused", tab.id);
    }
    return { tab, ...keptField };
  }

  /** A title the user typed. Bumps the revision and holds off agent titles for USER_TITLE_HOLD_MS. */
  renamePage(idOrKey: string, title: string): Tab {
    const tab = this.requireAny(idOrKey);
    const next = title.trim();
    if (!next) {
      throw new Error("title is required");
    }
    if (next === tab.title) {
      return tab;
    }
    const now = Date.now();
    tab.title = next;
    tab.userTitleAt = now;
    tab.updatedAt = now;
    tab.revision += 1;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /** Exchange strip coordinates of two open tabs in the same pin group. */
  swapStripSeq(aIdOrKey: string, bIdOrKey: string): void {
    const a = this.requireOpen(aIdOrKey);
    const b = this.requireOpen(bIdOrKey);
    if (a.id === b.id) {
      return;
    }
    if (a.pinned !== b.pinned) {
      throw new Error("cannot reorder across pin groups");
    }
    const seq = a.stripSeq;
    a.stripSeq = b.stripSeq;
    b.stripSeq = seq;
    this.markDirty(a.id);
    this.markDirty(b.id);
    this.rebuildOrder();
    this.persistSoon();
  }

  /**
   * Walk `id` to `targetIndexInGroup` inside its pin group by adjacent seq swaps.
   * Does not change activeId or revision.
   */
  moveByAdjacentSwaps(idOrKey: string, targetIndexInGroup: number): Tab {
    const tab = this.requireOpen(idOrKey);
    if (!Number.isFinite(targetIndexInGroup)) {
      throw new Error("target index is required");
    }
    const groupOf = (): string[] => this.order.filter((id) => this.tabs.get(id)?.pinned === tab.pinned);
    let group = groupOf();
    const from = group.indexOf(tab.id);
    if (from === -1) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const target = Math.max(0, Math.min(group.length - 1, Math.trunc(targetIndexInGroup)));
    if (from === target) {
      return tab;
    }
    const previous = new Map(this.order.map((id, index) => [id, index] as const));
    let at = from;
    while (at < target) {
      group = groupOf();
      this.swapStripSeq(group[at], group[at + 1]);
      at += 1;
    }
    while (at > target) {
      group = groupOf();
      this.swapStripSeq(group[at], group[at - 1]);
      at -= 1;
    }
    for (const id of this.order) {
      const next = this.order.indexOf(id);
      if (previous.get(id) === next) {
        continue;
      }
      const moved = this.tabs.get(id);
      if (moved) {
        this.emit("tab_upserted", toMeta(moved), next, { activate: false, structural: false });
      }
    }
    return tab;
  }

  /** Place an open tab before `before` in its pin group, or at the end when `before` is null. */
  reorderTab(idOrKey: string, before: string | null): Tab {
    const tab = this.requireOpen(idOrKey);
    const group = this.order.filter((id) => this.tabs.get(id)?.pinned === tab.pinned);
    let target = group.length - 1;
    if (before !== null) {
      const other = this.requireOpen(before);
      if (other.pinned !== tab.pinned) {
        throw new Error("cannot reorder across pin groups");
      }
      const beforeIndex = group.indexOf(other.id);
      const from = group.indexOf(tab.id);
      if (beforeIndex === -1 || from === -1) {
        throw new Error("cannot reorder across pin groups");
      }
      if (from === beforeIndex) {
        return tab;
      }
      target = from < beforeIndex ? beforeIndex - 1 : beforeIndex;
    }
    return this.moveByAdjacentSwaps(tab.id, target);
  }

  /**
   * Apply ops to a page's state. Strict by default (all or nothing); lenient skips ops that fail.
   * Viewers get the applied ops as a delta, so they never need the whole state again.
   */
  writeState(idOrKey: string, input: StateWriteInput): StateWriteResult {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = located.tab;
    if (input.expectedRevision !== undefined && input.expectedRevision !== tab.stateRevision) {
      return { ok: false, stateRevision: tab.stateRevision };
    }
    let ops = input.ops;
    const attached = input.assets?.length ? this.prepareStateAssets(tab, ops, input.assets) : undefined;
    if (attached) {
      ops = attached.value as unknown[];
    }
    const result = applyOps(tab.state, ops, { lenient: input.lenient === true });
    const resolved = this.applyResolveIncompatibility(tab, input.resolveIncompatibility);
    const fromRevision = tab.stateRevision;
    // applyOps shares every untouched part with tab.state, so both checks walk only the copied path.
    const stateChanged = result.applied.length > 0 && !deepEqual(result.state, tab.state);
    if (!stateChanged) {
      if (resolved) {
        this.markDirty(tab.id);
        this.persistSoon();
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
      }
      return { ok: true, tab, fromRevision, applied: [], skipped: result.skipped };
    }
    const bytes = jsonBytes(result.state);
    if (bytes > MAX_STATE_BYTES) {
      throw new Error(`state would be too large (${bytes} bytes, max ${MAX_STATE_BYTES})`);
    }
    const assets = attached ? this.insertPageAssetDrafts(tab, attached.drafts) : undefined;
    if (input.byUser && !input.actor) this.noteUserLinks(tab, tab.state, result.state);
    tab.state = result.state;
    tab.stateRevision += 1;
    tab.stateUpdatedAt = Date.now();
    noteAgentWrite(tab, input.actor);
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_state", tab, { fromRevision, ops: result.applied, client: input.client, writeId: input.writeId });
    if (located.where === "closed" || resolved || input.actor) {
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    }
    return { ok: true, tab, fromRevision, applied: result.applied, skipped: result.skipped, ...(assets ? { assets } : {}) };
  }

  /** A viewer's own state for a page (scribe.local): filters, open panels, drafts. */
  getLocal(idOrKey: string, viewer: string): BoardState {
    const tab = this.locate(idOrKey)?.tab;
    if (!tab || !this.db) {
      return {};
    }
    try {
      const parsed = JSON.parse(this.db.readLocal(tab.id, viewer) ?? "{}") as unknown;
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The most recently written `scribe.local` for this page, across desktop and browser viewers. */
  latestLocal(idOrKey: string): BoardState {
    const tab = this.locate(idOrKey)?.tab;
    if (!tab || !this.db) {
      return {};
    }
    try {
      const parsed = JSON.parse(this.db.readLatestLocal(tab.id) ?? "{}") as unknown;
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  setLocal(idOrKey: string, viewer: string, state: unknown): void {
    const tab = this.locate(idOrKey)?.tab;
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (!isPlainObject(state)) {
      throw new Error("local state must be a JSON object");
    }
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text, "utf8") > MAX_LOCAL_STATE_BYTES) {
      throw new Error(`local state is too large (max ${MAX_LOCAL_STATE_BYTES} bytes)`);
    }
    // The row points at the page's row, so a page created moments ago is written first.
    if (this.dirty.has(tab.id)) {
      this.persist();
    }
    this.requireDb().writeLocal(tab.id, viewer, Object.keys(state).length ? text : null);
  }

  /** The permissions the user granted a page; missing ones are at their default. */
  pagePermissions(idOrKey: string): Map<string, PermissionGrant> {
    const tab = this.locate(idOrKey)?.tab;
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const grants = new Map<string, PermissionGrant>();
    if (!this.db) {
      return grants;
    }
    for (const row of this.db.readPermissions(tab.id)) {
      if (!permissionDef(row.perm) || !isPermissionValue(row.value)) {
        continue;
      }
      let folders: FolderGrant[] | undefined;
      try {
        folders = row.data ? normalizeFolders((JSON.parse(row.data) as { folders?: unknown }).folders) : undefined;
      } catch {
        folders = undefined;
      }
      grants.set(row.perm, { value: row.value, ...(folders ? { folders } : {}), updatedAt: row.updatedAt });
    }
    return grants;
  }

  /**
   * Set one permission for a page. folders replaces the approved folders of a per-folder
   * permission; those have no blanket allow, so allow is stored as ask. Back at the default with no
   * folders, the grant is removed.
   */
  setPagePermission(idOrKey: string, perm: string, value: PermissionValue, folders?: unknown): Map<string, PermissionGrant> {
    const tab = this.locate(idOrKey)?.tab;
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const def = permissionDef(perm);
    if (!def) {
      throw new Error(`unknown permission: ${perm}`);
    }
    const stored = def.perFolder && value === "allow" ? "ask" : value;
    const list = def.perFolder ? (folders === undefined ? this.pagePermissions(tab.id).get(perm)?.folders ?? [] : normalizeFolders(folders)) : [];
    if (this.dirty.has(tab.id)) {
      this.persist();
    }
    const db = this.requireDb();
    if (stored === def.default && !list.length) {
      db.writePermission(tab.id, perm, null, null, Date.now());
    } else {
      db.writePermission(tab.id, perm, stored, list.length ? JSON.stringify({ folders: list }) : null, Date.now());
    }
    return this.pagePermissions(tab.id);
  }

  /**
   * A workspace folder moved (#338): rewrite the paths pages keep to it, which are the folders approved
   * for a page's agents and the folders of Kanban workers. move returns a path's new place, or null
   * when it is not in the moved folder. Returns how many pages changed.
   */
  moveWorkspacePaths(move: (dir: string) => string | null): number {
    let pages = 0;
    for (const tab of this.allTabs()) {
      let changed = false;
      if (this.db) {
        for (const [perm, grant] of this.pagePermissions(tab.id)) {
          const folders = (grant.folders ?? []).map((folder) => ({ ...folder, path: move(folder.path) ?? folder.path }));
          if (folders.some((folder, i) => folder.path !== grant.folders![i].path)) {
            this.setPagePermission(tab.id, perm, grant.value, folders);
            changed = true;
          }
        }
      }
      const settings = isPlainObject(tab.state) ? tab.state.settings : undefined;
      const workers = isPlainObject(settings) && isPlainObject(settings.workers) ? settings.workers : {};
      const ops = Object.entries(workers).flatMap(([id, worker]) => {
        const next = isPlainObject(worker) && typeof worker.cwd === "string" ? move(worker.cwd) : null;
        return next ? [{ op: "set", path: `settings/workers/${id.replaceAll("~", "~0").replaceAll("/", "~1")}/cwd`, value: next }] : [];
      });
      if (ops.length) {
        this.writeState(tab.id, { ops, lenient: true });
        changed = true;
      }
      if (changed) pages += 1;
    }
    return pages;
  }

  /** An agent rewrote the page's code: what it was trusted with no longer holds. Returns whether anything was reset. */
  resetRiskyPermissions(idOrKey: string): boolean {
    const tab = this.locate(idOrKey)?.tab;
    return tab ? this.resetRiskyGrants(tab) : false;
  }

  /** resetRiskyPermissions for every page made from a template an agent changed, in the Trash too. */
  resetTemplatePermissions(templateId: string): void {
    for (const tab of this.allTabs()) {
      if (tab.templateId === templateId) {
        this.resetRiskyGrants(tab);
      }
    }
  }

  private resetRiskyGrants(tab: Tab): boolean {
    if (!this.db) {
      return false;
    }
    let reset = false;
    for (const row of this.db.readPermissions(tab.id)) {
      if (permissionDef(row.perm)?.risky !== false) {
        this.db.writePermission(tab.id, row.perm, null, null, Date.now());
        reset = true;
      }
    }
    if (reset) {
      log(`Reset page permissions of ${tab.key} after an agent changed its code`);
    }
    return reset;
  }

  /** Log an event on a page, after applying any ops that came with it. Waits wake on it. */
  logEvent(idOrKey: string, input: EventInput): { tab: Tab; event: PageEvent; write?: StateWriteResult } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const name = normalizeSignalName(input.name);
    let data: unknown;
    if (input.data !== undefined && input.data !== null) {
      const text = JSON.stringify(input.data);
      if (text === undefined) {
        throw new Error("event data must be JSON");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_EVENT_DATA_BYTES) {
        throw new Error(`event data is too large (max ${MAX_EVENT_DATA_BYTES} bytes); keep ids in it and the rest in state`);
      }
      data = JSON.parse(text);
    }
    const write = input.ops?.length
      ? this.writeState(located.tab.id, { ops: input.ops, lenient: true, client: input.client, writeId: input.writeId, actor: input.actor, byUser: input.by === "user" })
      : undefined;
    const tab = located.tab;
    tab.eventSeq += 1;
    const event: PageEvent = { seq: tab.eventSeq, name, ...(data !== undefined ? { data } : {}), at: Date.now(), by: input.by };
    tab.events.push(event);
    if (tab.events.length > MAX_PAGE_EVENTS) {
      tab.events.splice(0, tab.events.length - MAX_PAGE_EVENTS);
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_event", tab, event);
    return { tab, event, ...(write ? { write } : {}) };
  }

  focus(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where === "closed") {
      return this.restore(located.tab.id, { placement: "append", activate: true });
    }
    this.activeId = located.tab.id;
    this.persistSoon();
    this.emit("tab_focused", located.tab.id);
    return located.tab;
  }

  /** Remove a page's tab from the strip. The page stays where it is in the Library. */
  closeTab(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
    }
    if (located.where === "closed") {
      return located.tab;
    }
    const tab = located.tab;
    const prevOrder = this.order;
    this.tabs.delete(tab.id);
    this.rebuildOrder();
    tab.closedAt = this.stamp();
    this.closed.set(tab.id, tab);
    if (this.activeId === tab.id) {
      this.activeId = this.neighborOf(prevOrder, tab.id);
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    this.emit("tab_closed", tab.id);
    this.emit("tab_focused", this.activeId);
    return tab;
  }

  closeMany(filter: "all" | "unpinned", viewer: Viewer = "user"): string[] {
    const ids = this.listOpenTabs(viewer)
      .filter((tab) => filter === "all" || !tab.pinned)
      .map((tab) => tab.id);
    const closed: string[] = [];
    for (const id of ids) {
      this.closeTab(id);
      if (this.closed.has(id)) {
        closed.push(id);
      }
    }
    return closed;
  }

  /** Open or closed pages to the deleted bin as one undoable batch. */
  deleteMany(idsOrKeys: string[], folderIds: string[] = []): Tab[] {
    const batch: DeletedBatch = { id: newBatchId(), deletedAt: this.stamp(), tabs: [], folders: [] };
    const treeIds = new Set<string>();
    for (const id of folderIds) {
      this.requireFolder(id);
      for (const child of this.subtreeFolderIds(id)) treeIds.add(child);
    }
    batch.folders = this.listFolders().filter((folder) => treeIds.has(folder.id)).sort((a, b) => this.folderDepth(a) - this.folderDepth(b));
    const pageIds = new Set([...idsOrKeys, ...this.libraryTabs().filter((tab) => tab.folderId && treeIds.has(tab.folderId)).map((tab) => tab.id)]);
    const wasActive = this.activeId;
    const prevOrder = this.order;
    for (const idOrKey of pageIds) {
      const located = this.locate(idOrKey);
      if (!located) {
        continue;
      }
      if (isAppTab(located.tab)) {
        this.discardAppTab(located.tab);
        continue;
      }
      this.detach(located);
      batch.tabs.push(located.tab);
    }
    if (!batch.tabs.length && !batch.folders.length) {
      return [];
    }
    this.pushDeleted(batch);
    for (const folder of batch.folders) this.folders.delete(folder.id);
    if (batch.folders.length) this.foldersDirty = true;
    this.rebuildOrder();
    if (this.activeId && !this.tabs.has(this.activeId)) {
      this.activeId = this.neighborOf(prevOrder, this.activeId);
    }
    this.persistSoon();
    for (const tab of batch.tabs) {
      this.emit("tab_deleted", tab.id);
    }
    if (batch.folders.length) this.emitFolders();
    if (wasActive !== this.activeId) {
      this.emit("tab_focused", this.activeId);
    }
    return batch.tabs;
  }

  deletePermanent(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
    }
    this.deleteMany([located.tab.id]);
    return located.tab;
  }

  /** Pages whose `basis` date is older than `days`. Closed pages only unless `includeOpen`; pinned ones only with `includePinned`. */
  cleanupCandidates(opts: CleanupOptions): Tab[] {
    const { days, basis = "activity", includeOpen = false, includePinned = false } = opts;
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("days must be a positive number");
    }
    if (!CLEANUP_BASES.includes(basis)) {
      throw new Error(`basis must be one of: ${CLEANUP_BASES.join(", ")}`);
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const pool = includeOpen ? [...this.tabs.values(), ...this.closed.values()] : [...this.closed.values()];
    // A tab in another space counts as open: it is only parked until the user switches back.
    const parked = this.parkedTabs();
    return pool.filter((tab) => {
      const parkedTab = parked.get(tab.id);
      if (isAppTab(tab) || (parkedTab && !includeOpen) || ((tab.pinned || parkedTab?.pinned) && !includePinned)) {
        return false;
      }
      const at = cleanupDate(tab, basis);
      return at !== undefined && at < cutoff;
    });
  }

  /** Deletes the cleanup candidates as one batch (undoable from the Trash). */
  cleanup(opts: CleanupOptions): Tab[] {
    return this.deleteMany(this.cleanupCandidates(opts).map((tab) => tab.id));
  }

  restore(idOrKey: string, opts?: { placement?: RestorePlacement; activate?: boolean }): Tab {
    const id = this.locate(idOrKey)?.tab.id ?? idOrKey;
    const tab = this.closed.get(id);
    if (!tab) {
      throw new Error(`closed page not found: ${idOrKey}`);
    }
    return this.restoreTab(tab, opts?.placement ?? "append", opts?.activate !== false);
  }

  /** Give a page a tab (or reuse its tab), optionally placed before another tab in the same pin group. */
  openPage(idOrKey: string, opts: { activate?: boolean; before?: string | null } = {}): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const activate = opts.activate !== false;
    const tab =
      located.where === "closed" ? this.restoreTab(located.tab, "append", activate) : located.tab;
    if (opts.before !== undefined) {
      const other = opts.before ? this.tabs.get(opts.before) : undefined;
      if (opts.before === null || (other && other.pinned === tab.pinned && other.id !== tab.id)) {
        this.reorderTab(tab.id, opts.before);
      }
    }
    if (located.where === "open" && activate) {
      this.focus(tab.id);
    }
    return tab;
  }

  /** Ctrl+Z: the newer of the last delete batch and the last closed page. */
  restoreLast(): { tab: Tab | null } {
    let newestClosed: Tab | undefined;
    const parked = this.parkedTabs();
    for (const tab of this.closed.values()) {
      if (parked.has(tab.id) || isAppTab(tab)) {
        continue;
      }
      if (!newestClosed || (tab.closedAt ?? 0) > (newestClosed.closedAt ?? 0)) {
        newestClosed = tab;
      }
    }
    const batch = this.deleted[this.deleted.length - 1];
    if (!newestClosed && !batch) {
      throw new Error("nothing to restore");
    }
    if (batch && (!newestClosed || batch.deletedAt >= (newestClosed.closedAt ?? 0))) {
      this.deleted.pop();
      const tab = this.restoreBatch(batch);
      this.emit("trash");
      return { tab };
    }
    return { tab: this.restoreTab(newestClosed!, "index", true) };
  }

  /* ---------- Spaces ---------- */

  readAppearance(): Record<string, string> {
    return this.db?.readAppearance() ?? {};
  }

  writeAppearance(settings: Record<string, string>): void {
    if (!this.db) throw new Error("Database is not loaded");
    this.db.writeAppearance(settings);
  }

  spacesView(): SpacesView {
    const live = this.liveStrip();
    return {
      spaces: this.spaces.list.map((space) => {
        const active = space.id === this.spaces.activeId;
        return {
          ...space,
          tabs: active ? live : space.tabs.filter((entry) => this.locate(entry.id)),
          activeId: active ? this.activeId : space.activeId,
          active,
        };
      }),
      activeId: this.spaces.activeId,
      deleted: [...this.spaces.deleted].reverse().map(({ space, deletedAt }) => ({
        id: space.id,
        name: space.name,
        color: space.color,
        tabs: space.tabs.length,
        deletedAt,
      })),
    };
  }

  /** The first use turns the current strip into a space, so nothing is lost. */
  ensureSpaces(): void {
    if (this.spaces.list.length) {
      return;
    }
    const now = Date.now();
    const first: Space = {
      id: newSpaceId(),
      name: "Main",
      color: nextSpaceColor([]),
      tabs: this.liveStrip(),
      activeId: this.activeId,
      createdAt: now,
      usedAt: now,
    };
    this.spaces.list = [first];
    this.spaces.activeId = first.id;
    this.spacesDirty = true;
  }

  private liveStrip(): SpaceTab[] {
    return this.order
      .map((id) => this.tabs.get(id)!)
      .filter((tab) => !isAppTab(tab))
      .map((tab) => ({ id: tab.id, pinned: tab.pinned }));
  }

  /** Closed pages that are tabs in a space other than the active one, by id. */
  private parkedTabs(): Map<string, SpaceTab> {
    const parked = new Map<string, SpaceTab>();
    for (const space of this.spaces.list) {
      if (space.id === this.spaces.activeId) {
        continue;
      }
      for (const entry of space.tabs) {
        if (this.closed.has(entry.id) && !parked.get(entry.id)?.pinned) {
          parked.set(entry.id, entry);
        }
      }
    }
    return parked;
  }

  private requireSpace(id: string): Space {
    const space = this.spaces.list.find((item) => item.id === id);
    if (!space) {
      throw new Error(`space not found: ${id}`);
    }
    return space;
  }

  private spacesChanged(): void {
    this.spacesDirty = true;
    this.persistSoon();
    this.emit("spaces", this.spacesView());
  }

  /** The space's home folder (#260), while that folder still exists. */
  spaceHome(spaceId: string | undefined | null): string | undefined {
    const home = spaceId ? this.spaces.list.find((space) => space.id === spaceId)?.home : undefined;
    return home && this.folders.has(home) ? home : undefined;
  }

  /** The active space, once the user has spaces. */
  activeSpaceId(): string | undefined {
    return this.spaces.activeId ?? undefined;
  }

  /** The spaces whose home folder this is (#260), by name. */
  homeOfSpaces(folderId: string): string[] {
    return this.spaces.list.filter((space) => space.home === folderId).map((space) => space.name);
  }

  /**
   * The space a new page is made in (#260): the space its chat was started in, else the active one.
   * An agent outside a chat (an external MCP client) works for the user's current space.
   */
  private newPageSpace(actor: PageActor | undefined): string | undefined {
    const space = actor?.space;
    if (space && this.spaces.list.some((item) => item.id === space)) {
      return space;
    }
    return this.spaces.activeId ?? undefined;
  }

  /** A page that becomes a Library page without a folder of its own goes to its space's home. */
  private placeNew(tab: Tab, actor?: PageActor): void {
    if (!tab.madeIn) {
      const madeIn = this.newPageSpace(actor);
      if (madeIn) {
        tab.madeIn = madeIn;
      }
    }
    if (!tab.folderId) {
      const home = this.spaceHome(tab.madeIn);
      if (home) {
        tab.folderId = home;
      }
    }
  }

  /** A new space, empty or with a copy of the current tabs, at the end of the list. */
  createSpace(input: { name?: unknown; color?: unknown; copyTabs?: boolean; activate?: boolean } = {}): Space {
    this.ensureSpaces();
    const now = Date.now();
    const space: Space = {
      id: newSpaceId(),
      name: cleanSpaceName(input.name, nextSpaceName(this.spaces.list)),
      color: isSpaceColor(input.color) ? input.color : nextSpaceColor(this.spaces.list),
      tabs: input.copyTabs ? this.liveStrip() : [],
      activeId: input.copyTabs ? this.activeId : null,
      createdAt: now,
      usedAt: now,
    };
    this.spaces.list.push(space);
    if (input.activate) {
      this.switchSpace(space.id);
    } else {
      this.spacesChanged();
    }
    return space;
  }

  updateSpace(id: string, patch: { name?: unknown; color?: unknown; home?: unknown; lens?: unknown }): Space {
    this.ensureSpaces();
    const space = this.requireSpace(id);
    if (patch.home !== undefined) {
      if (patch.home === null || patch.home === "") {
        delete space.home;
      } else if (typeof patch.home === "string" && this.folders.has(patch.home)) {
        space.home = patch.home;
      } else {
        throw new Error(`folder not found: ${String(patch.home)}`);
      }
    }
    if (patch.lens !== undefined) {
      const lens = patch.lens === null ? undefined : normalizeLens(patch.lens);
      if (lens) {
        space.lens = lens;
      } else {
        delete space.lens;
      }
    }
    if (patch.name !== undefined) {
      space.name = cleanSpaceName(patch.name, space.name);
    }
    if (patch.color !== undefined) {
      if (!isSpaceColor(patch.color)) {
        throw new Error(`unknown space color: ${String(patch.color)}`);
      }
      space.color = patch.color;
    }
    this.spacesChanged();
    return space;
  }

  moveSpace(id: string, index: number): Space {
    this.ensureSpaces();
    const space = this.requireSpace(id);
    const list = this.spaces.list.filter((item) => item.id !== id);
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : list.length, list.length));
    list.splice(at, 0, space);
    this.spaces.list = list;
    this.spacesChanged();
    return space;
  }

  /**
   * Remove a space. Its pages stay in the Library, and undo brings the space back with its tabs.
   * Deleting the active space switches to its neighbor first. The last space can't be deleted.
   */
  deleteSpace(id: string): Space {
    this.ensureSpaces();
    const space = this.requireSpace(id);
    if (this.spaces.list.length <= 1) {
      throw new Error("the last space can't be deleted");
    }
    let index = this.spaces.list.indexOf(space);
    if (space.id === this.spaces.activeId) {
      const next = this.spaces.list[index + 1] ?? this.spaces.list[index - 1];
      this.switchSpace(next.id);
      index = this.spaces.list.indexOf(space);
    }
    this.spaces.list.splice(index, 1);
    this.spaces.deleted.push({ space, index, deletedAt: Date.now() });
    this.spaces.deleted = this.spaces.deleted.slice(-SPACE_UNDO_MAX);
    this.spacesChanged();
    return space;
  }

  /** Bring back a deleted space (the newest when no id) where it was. */
  restoreSpace(id?: string): Space {
    const at = id
      ? this.spaces.deleted.findIndex((entry) => entry.space.id === id)
      : this.spaces.deleted.length - 1;
    if (at < 0) {
      throw new Error(id ? `deleted space not found: ${id}` : "no deleted space to restore");
    }
    const [entry] = this.spaces.deleted.splice(at, 1);
    const index = Math.max(0, Math.min(entry.index, this.spaces.list.length));
    this.spaces.list.splice(index, 0, entry.space);
    this.spacesChanged();
    return entry.space;
  }

  /**
   * Make a space the live strip: the current tabs go back into the current space (closed in the
   * Library), and the target's tabs open in their saved order with their pins and focused tab.
   * Viewers get a fresh snapshot ("reset") instead of a close and an open per tab.
   */
  switchSpace(id: string): Space {
    this.ensureSpaces();
    const target = this.requireSpace(id);
    if (target.id === this.spaces.activeId) {
      return target;
    }
    const now = Date.now();
    const current = this.spaces.list.find((space) => space.id === this.spaces.activeId);
    if (current) {
      current.tabs = this.liveStrip();
      current.activeId = this.activeId;
      current.usedAt = now;
    }
    const want = target.tabs.filter((entry) => this.locate(entry.id));
    const wantIds = new Set(want.map((entry) => entry.id));
    for (const tabId of [...this.order]) {
      const tab = this.tabs.get(tabId)!;
      if (isAppTab(tab)) {
        this.tabs.delete(tabId);
        this.removed.add(tabId);
        this.dirty.delete(tabId);
        deleteTabAssets(tabId);
        continue;
      }
      if (!wantIds.has(tabId)) {
        this.tabs.delete(tabId);
        tab.closedAt = this.stamp();
        this.closed.set(tabId, tab);
        this.markDirty(tabId);
      }
    }
    for (const entry of want) {
      let tab = this.tabs.get(entry.id);
      if (!tab) {
        tab = this.closed.get(entry.id)!;
        this.closed.delete(tab.id);
        this.claimKey(tab);
        delete tab.closedAt;
        this.tabs.set(tab.id, tab);
      }
      tab.pinned = entry.pinned;
      tab.stripSeq = this.nextSeq();
      this.markDirty(tab.id);
    }
    this.rebuildOrder();
    this.activeId = target.activeId && this.tabs.has(target.activeId) ? target.activeId : (this.order[0] ?? null);
    target.tabs = this.liveStrip();
    target.usedAt = now;
    this.spaces.activeId = target.id;
    this.spacesChanged();
    this.emit("reset");
    return target;
  }

  /** The next or previous space in list order, wrapping. */
  cycleSpace(step: number): Space {
    this.ensureSpaces();
    const list = this.spaces.list;
    const at = Math.max(0, list.findIndex((space) => space.id === this.spaces.activeId));
    const next = list[(at + (step < 0 ? list.length - 1 : 1)) % list.length];
    return this.switchSpace(next.id);
  }

  /** Deleted batches, newest first. */
  listTrash(viewer: Viewer = "user"): TrashBatch[] {
    return this.deleted
      .map((batch) => ({
        id: batch.id,
        deletedAt: batch.deletedAt,
        expiresAt: batch.deletedAt + TRASH_TTL_MS,
        tabs: batch.tabs.filter((tab) => visibleTo(tab, viewer)).map(toMeta),
        folders: batch.folders,
      }))
      .filter((batch) => batch.tabs.length || batch.folders.length)
      .reverse();
  }

  /** Put a trashed page, or a trashed folder with what it held, back in the Library (closed). */
  restoreFromTrash(id: string): { tabs: Tab[]; folders: Folder[] } {
    const part = this.takeFromTrash(id);
    for (const tab of part.tabs) {
      if (typeof tab.closedAt !== "number") {
        tab.closedAt = this.stamp();
      }
    }
    this.restoreBatch(part);
    this.emit("trash");
    return { tabs: part.tabs, folders: part.folders };
  }

  /** Delete a trashed page, or a trashed folder with what it held, for good. */
  purgeFromTrash(id: string): number {
    const part = this.takeFromTrash(id);
    this.dropForever(part);
    this.persistSoon();
    this.emit("trash");
    return part.tabs.length;
  }

  emptyTrash(): number {
    let count = 0;
    for (const batch of this.deleted.splice(0)) {
      count += batch.tabs.length;
      this.dropForever(batch);
    }
    this.persistSoon();
    this.emit("trash");
    return count;
  }

  createFolder(input: { name: string; parentId?: string | null; index?: number }): Folder {
    const parentId = input.parentId ?? null;
    if (parentId && !this.folders.has(parentId)) {
      throw new Error(`folder not found: ${parentId}`);
    }
    const now = Date.now();
    const folder: Folder = {
      id: newFolderId(),
      parentId,
      name: cleanFolderName(input.name),
      pos: this.folderPosAt(parentId, input.index ?? Number.POSITIVE_INFINITY),
      createdAt: now,
      updatedAt: now,
    };
    this.folders.set(folder.id, folder);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  renameFolder(id: string, name: string): Folder {
    const folder = this.requireFolder(id);
    const next = cleanFolderName(name);
    if (next !== folder.name) {
      this.pinDiskPath(folder);
      folder.name = next;
      folder.updatedAt = Date.now();
      this.foldersDirty = true;
      this.persistSoon();
      this.emitFolders();
    }
    return folder;
  }

  moveFolder(id: string, parentId: string | null, index: number): Folder {
    const folder = this.requireFolder(id);
    if (parentId) {
      this.requireFolder(parentId);
      if (this.subtreeFolderIds(folder.id).has(parentId)) {
        throw new Error("cannot move a folder into itself");
      }
    }
    if (folder.parentId !== parentId) {
      this.pinDiskPath(folder);
    }
    folder.parentId = parentId;
    folder.pos = this.folderPosAt(parentId, index, folder.id);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  movePage(idOrKey: string, folderId: string | null, index: number, opts: { close?: boolean } = {}): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.tab.temp) {
      // Dragging a temporary page into the Library keeps it there.
      if (folderId) {
        this.requireFolder(folderId);
      }
      delete located.tab.temp;
    } else if (isAppTab(located.tab)) {
      throw new Error("the help page is not part of the Library");
    }
    if (folderId) {
      this.requireFolder(folderId);
    }
    const tab = located.tab;
    tab.libPos = this.pagePosAt(folderId, index, tab.id);
    if (folderId) {
      tab.folderId = folderId;
    } else {
      delete tab.folderId;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    if (opts.close && located.where === "open") {
      return this.closeTab(tab.id);
    }
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /** The page that has this file open, if any (#654). */
  findFilePage(file: string): Tab | undefined {
    for (const tab of [...this.tabs.values(), ...this.closed.values()]) {
      if (tab.file && samePath(tab.file.path, file)) {
        return tab;
      }
    }
    return undefined;
  }

  /**
   * Open a file as a page (#654): the page that already has it, or a new one named after the file.
   * bytes: a dropped file with no path; Scribe keeps a copy in its data folder. folderId puts a new
   * page in a Library folder; activate opens it in a tab (else it lands in the Library only).
   */
  openFilePage(input: { path?: string; name?: string; bytes?: Buffer; folderId?: string | null; activate?: boolean; temp?: boolean }): { tab: Tab; created: boolean } {
    const activate = input.activate !== false;
    if (input.path) {
      const existing = this.findFilePage(input.path);
      if (existing) {
        if (existing.temp && !input.temp) {
          this.keepPage(existing.id);
        }
        if (activate) {
          this.openPage(existing.id);
        }
        return { tab: existing, created: false };
      }
    } else if (!input.bytes) {
      throw new Error("path or bytes is required");
    }
    const name = input.path ? path.basename(input.path) || input.path : safeFileName(input.name ?? "file");
    if (input.folderId) {
      this.requireFolder(input.folderId);
    }
    const { tab } = this.upsert({ title: name, html: filePlaceholderHtml(name, input.path ?? name), activate, temp: input.temp === true && !input.folderId });
    try {
      tab.file = input.path ? { path: path.resolve(input.path) } : { path: storeCopy(tab.id, name, input.bytes!), copy: true };
    } catch (err) {
      this.deleteMany([tab.id]);
      throw err;
    }
    tab.html = filePlaceholderHtml(name, tab.file.path);
    if (input.folderId) {
      return { tab: this.movePage(tab.id, input.folderId, 0), created: true };
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return { tab, created: true };
  }

  /**
   * A website as a temporary page (#403, #655): an embed page for the URL, so a site in a split
   * has a tab like any page. Reuses a temporary page that already shows it.
   */
  openTempUrl(url: string, opts: { activate?: boolean } = {}): { tab: Tab; created: boolean } {
    const href = safeEmbedUrl(url);
    if (!href) {
      throw new Error("an http(s) URL outside Scribe is required");
    }
    const activate = opts.activate === true;
    for (const tab of [...this.tabs.values(), ...this.closed.values()]) {
      if (tab.temp && embedUrlFromHtml(tab.html) === href) {
        if (activate) {
          this.openPage(tab.id);
        }
        return { tab, created: false };
      }
    }
    let title = href;
    try {
      title = new URL(href).host || href;
    } catch {
      /* the URL parsed above */
    }
    const { tab } = this.upsert({ title, html: embedPageHtml(href, title), activate, temp: true });
    return { tab, created: true };
  }

  /** Keep in Library: a temporary page becomes a page like any other (#655). */
  keepPage(idOrKey: string): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.temp) {
      return tab;
    }
    delete tab.temp;
    this.placeNew(tab);
    tab.libPos = this.pagePosAt(tab.folderId ?? null, 0, tab.id);
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /**
   * Save as for a file page: point it at another file (written by the caller) and name it after
   * that file. A copy's old bytes go once the page no longer uses them.
   */
  setFilePath(idOrKey: string, file: string): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.file) {
      throw new Error("not a file page");
    }
    const wasCopy = tab.file.copy;
    const name = path.basename(file) || file;
    tab.file = { path: path.resolve(file) };
    tab.html = filePlaceholderHtml(name, tab.file.path);
    tab.title = name;
    tab.updatedAt = Date.now();
    tab.revision += 1;
    if (wasCopy) {
      removeCopies(tab.id);
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /**
   * Open folder (#654): a Library folder for the disk folder and each subfolder in it, and a file
   * page for each file, all in the Library (no tabs). Files that already have a page keep it.
   * The folder stays linked to the disk folder (#707); opening a disk folder that a Library folder
   * already stands for brings that folder up to date instead of making a second one.
   */
  openDiskFolder(root: string, parentId: string | null): { folder: Folder; pages: number; reused: number; truncated: boolean } {
    const abs = path.resolve(root);
    const { tree, truncated, files } = scanFolder(abs);
    const linked = this.folderOnDisk(abs);
    if (linked) {
      const pages = this.addDiskFiles(folderEntryFiles(tree));
      return { folder: linked, pages, reused: files - pages, truncated };
    }
    let pages = 0;
    let reused = 0;
    const make = (entry: FolderEntry & { kind: "dir" }, parent: string | null): Folder => {
      const folder = this.createFolder({ name: entry.name, parentId: parent });
      // Subfolders inherit their disk path from the name; link explicitly where the name differs.
      if (entry === tree || !samePath(this.folderDiskPath(folder.id) ?? "", entry.path)) {
        folder.disk = entry.path;
      }
      let index = 0;
      for (const child of entry.children) {
        if (child.kind === "dir") {
          make(child, folder.id);
          continue;
        }
        // A file that already has a page moves into the folder with the rest.
        const { tab, created } = this.openFilePage({ path: child.path, activate: false });
        if (created) {
          pages += 1;
        } else {
          reused += 1;
        }
        this.movePage(tab.id, folder.id, index++);
      }
      return folder;
    };
    const folder = make(tree, parentId);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return { folder, pages, reused, truncated };
  }

  /* ---------- disk folders (#707) ---------- */

  private diskWatcher: DiskWatcher | null = null;

  fileSettings(): FileSettings {
    return normalizeFileSettings(this.db?.readMetaJson("files"));
  }

  /** Change where new files go or what deleting a file page does; null clears a setting. */
  setFileSettings(patch: { defaultLocation?: string | null; deleteFiles?: string | null }): FileSettings {
    if (!this.db) throw new Error("Database is not loaded");
    const next: Record<string, unknown> = { ...this.fileSettings() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null || value === "") delete next[key];
      else next[key] = value;
    }
    if (typeof next.defaultLocation === "string" && !isDir(path.resolve(next.defaultLocation))) {
      throw new Error(`folder not found: ${next.defaultLocation}`);
    }
    const settings = normalizeFileSettings(next);
    this.db.writeMetaJson("files", settings);
    this.emit("file_settings", settings);
    return settings;
  }

  /**
   * The disk folder a Library folder stands for: its own link, else its parent's location plus
   * its name (inherited), else null.
   */
  folderDiskPath(folderId: string | null | undefined): string | null {
    const names: string[] = [];
    let at = folderId ? this.folders.get(folderId) : undefined;
    for (let depth = 0; at && depth < 64; depth++) {
      if (at.disk) {
        return path.join(at.disk, ...names.reverse());
      }
      names.push(safeFileName(at.name));
      at = at.parentId ? this.folders.get(at.parentId) : undefined;
    }
    return null;
  }

  /** The Library folder that stands for this disk folder, by its own link or inherited. */
  folderOnDisk(dir: string): Folder | undefined {
    for (const folder of this.folders.values()) {
      const at = this.folderDiskPath(folder.id);
      if (at && samePath(at, dir)) {
        return folder;
      }
    }
    return undefined;
  }

  /** Link a Library folder to a disk folder, or unlink it (null). One Library folder per disk folder. */
  setFolderDisk(id: string, dir: string | null): Folder {
    const folder = this.requireFolder(id);
    if (dir) {
      const abs = path.resolve(dir);
      if (!isDir(abs)) {
        throw new Error(`folder not found: ${abs}`);
      }
      const taken = this.folderOnDisk(abs);
      if (taken && taken.id !== id) {
        throw new DiskLinkTakenError(taken.id, taken.name);
      }
      folder.disk = abs;
    } else {
      delete folder.disk;
    }
    folder.updatedAt = Date.now();
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  /**
   * Before a rename or move: a subfolder that inherits its disk path from its name keeps the disk
   * folder it already has files in, as an explicit link.
   */
  private pinDiskPath(folder: Folder): void {
    if (folder.disk) return;
    const at = this.folderDiskPath(folder.id);
    if (at && isDir(at)) {
      folder.disk = at;
    }
  }

  /**
   * A new empty file as a page in Library folder folderId (#707). It goes in that folder's disk
   * location, else in `location` (the user's pick when there was none), else in the default
   * location; with none of them it throws NeedsLocationError and creates nothing. `file` is an
   * exact path the user chose (Other…).
   */
  createFile(input: { folderId?: string | null; name?: string; file?: string; location?: string; remember?: boolean; activate?: boolean }): Tab {
    const folderId = input.folderId ?? null;
    if (folderId) {
      this.requireFolder(folderId);
    }
    let file: string;
    if (input.file) {
      file = path.resolve(input.file);
      if (fs.existsSync(file)) {
        throw new FileExistsError(file);
      }
    } else {
      const dir = this.folderDiskPath(folderId) ?? (input.location ? path.resolve(input.location) : null) ?? this.fileSettings().defaultLocation ?? null;
      if (!dir) {
        throw new NeedsLocationError();
      }
      file = uniqueFileName(dir, input.name || "Untitled.md");
    }
    if (input.location && input.remember) {
      fs.mkdirSync(path.resolve(input.location), { recursive: true });
      this.setFileSettings({ defaultLocation: input.location });
    }
    createEmptyFile(file);
    return this.openFilePage({ path: file, folderId, activate: input.activate !== false }).tab;
  }

  /**
   * Moving a file page into a Library folder on disk moves its file there (#707); a dropped
   * copy becomes a real file. Outside disk folders, or already there, the file stays. A name
   * already in the folder throws FileExistsError unless keepBoth (then "name 2.ext").
   */
  moveFileWithPage(idOrKey: string, folderId: string | null, opts: { keepBoth?: boolean } = {}): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.file) {
      return tab;
    }
    const dir = this.folderDiskPath(folderId);
    if (!dir || samePath(path.dirname(tab.file.path), dir)) {
      return tab;
    }
    const name = path.basename(tab.file.path);
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      if (!opts.keepBoth) {
        throw new FileExistsError(target);
      }
      target = uniqueFileName(dir, name);
    }
    if (tab.file.copy) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(tab.file.path, target, fs.constants.COPYFILE_EXCL);
    } else {
      moveFile(tab.file.path, target);
    }
    return this.setFilePath(tab.id, target);
  }

  /** Watch the linked disk folders (#707): files added there outside Scribe get pages. */
  watchDisk(): DiskWatcher {
    this.diskWatcher ??= new DiskWatcher({
      diskLinks: () => [...this.folders.values()].flatMap((folder) => (folder.disk ? [folder.disk] : [])),
      diskChanged: (paths) => this.diskChanged(paths),
      reconcileDisk: (root) => this.rescanDisk(root),
    });
    this.diskWatcher.sync();
    return this.diskWatcher;
  }

  stopDiskWatch(): void {
    this.diskWatcher?.stop();
    this.diskWatcher = null;
  }

  /** Disk folders whose watcher failed (Rescan in the folder menu still works). */
  unwatchedDisk(): string[] {
    return this.diskWatcher?.failedRoots() ?? [];
  }

  /** Pages for files under a disk folder that have none yet (start-up, Rescan). Returns how many. */
  rescanDisk(root: string): number {
    const { tree } = scanFolder(root);
    return this.addDiskFiles(folderEntryFiles(tree));
  }

  /** Rescan a Library folder's disk location. */
  rescanFolder(id: string): number {
    this.requireFolder(id);
    const dir = this.folderDiskPath(id);
    if (!dir) {
      throw new Error("this folder is not on disk");
    }
    return isDir(dir) ? this.rescanDisk(dir) : 0;
  }

  /**
   * Changed paths from the disk watcher: a new file gets a page in the Library folder for its disk
   * folder; a file renamed in place (gone plus new in one folder) keeps its page. Deleted files keep
   * their page, which shows the file as missing.
   */
  diskChanged(paths: string[]): void {
    const known = this.knownFilePaths();
    const norm = normPath;
    const added: string[] = [];
    const gone: Tab[] = [];
    for (const p of paths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        const tab = known.get(norm(p));
        if (tab) gone.push(tab);
        continue;
      }
      if (stat.isDirectory()) {
        // A folder moved or copied in: its files may come without events of their own.
        try {
          added.push(...folderEntryFiles(scanFolder(p).tree).filter((file) => !known.has(norm(file))));
        } catch {
          /* gone again */
        }
      } else if (stat.isFile() && !known.has(norm(p))) {
        added.push(p);
      }
    }
    for (const tab of gone) {
      const dir = norm(path.dirname(tab.file!.path));
      const here = added.filter((file) => norm(path.dirname(file)) === dir);
      const goneHere = gone.filter((other) => norm(path.dirname(other.file!.path)) === dir);
      if (here.length === 1 && goneHere.length === 1) {
        this.setFilePath(tab.id, here[0]);
        added.splice(added.indexOf(here[0]), 1);
      }
    }
    this.addDiskFiles(added, known);
  }

  /** Every file page's path (open, closed, or in the bin), so a file never gets a second page. */
  private knownFilePaths(): Map<string, Tab> {
    const known = new Map<string, Tab>();
    const tabs = [...this.tabs.values(), ...this.closed.values(), ...this.deleted.flatMap((batch) => batch.tabs)];
    for (const tab of tabs) {
      if (tab.file && !tab.file.copy) known.set(normPath(tab.file.path), tab);
    }
    return known;
  }

  /** Pages for these files in the Library folders their disk folders map to. Returns how many were made. */
  private addDiskFiles(files: string[], known = this.knownFilePaths()): number {
    if (!files.length) return 0;
    const roots: Array<{ id: string; dir: string }> = [];
    for (const folder of this.folders.values()) {
      const dir = this.folderDiskPath(folder.id);
      if (dir) roots.push({ id: folder.id, dir });
    }
    let made = 0;
    for (const file of files) {
      if (known.has(normPath(file))) continue;
      const folderId = this.libraryFolderFor(path.dirname(file), roots);
      if (!folderId) continue;
      const { tab, created } = this.openFilePage({ path: file, folderId, activate: false });
      known.set(normPath(file), tab);
      if (created) made += 1;
    }
    if (this.foldersDirty) {
      this.persistSoon();
      this.emitFolders();
    }
    return made;
  }

  /** The Library folder for a disk folder: the deepest one on it or above it, with subfolders made below. */
  private libraryFolderFor(dir: string, roots: Array<{ id: string; dir: string }>): string | null {
    let best: { id: string; dir: string } | null = null;
    for (const root of roots) {
      if (within(root.dir, dir) && (!best || root.dir.length > best.dir.length)) best = root;
    }
    if (!best) return null;
    let at = best.id;
    let atDir = best.dir;
    for (const part of path.relative(best.dir, dir).split(/[\\/]+/).filter(Boolean)) {
      atDir = path.join(atDir, part);
      const parent = at;
      const child =
        this.foldersIn(parent).find((folder) => samePath(this.folderDiskPath(folder.id) ?? "", atDir)) ??
        this.createFolder({ name: part, parentId: parent });
      if (!samePath(this.folderDiskPath(child.id) ?? "", atDir)) {
        child.disk = atDir;
        this.foldersDirty = true;
      }
      roots.push({ id: child.id, dir: atDir });
      at = child.id;
    }
    return at;
  }

  /** `lift` moves the folder's contents up to its parent; `delete` bins the whole subtree as one batch. */
  deleteFolder(id: string, mode: FolderDeleteMode): { deleted: Tab[]; moved: Tab[] } {
    const folder = this.requireFolder(id);
    switch (mode) {
      case "lift":
        return { deleted: [], moved: this.liftFolder(folder) };
      case "delete":
        return { deleted: this.deleteFolderTree(folder), moved: [] };
      default: {
        const _never: never = mode;
        return _never;
      }
    }
  }

  /** Open the folder's own pages in Library order and focus the first. */
  openFolder(id: string): Tab[] {
    this.requireFolder(id);
    const pages = this.pagesIn(id);
    const opened: Tab[] = [];
    for (const tab of pages) {
      if (this.closed.has(tab.id)) {
        opened.push(this.restoreTab(tab, "append", false));
      }
    }
    const first = pages[0];
    if (first) {
      this.focus(first.id);
    }
    return opened;
  }

  closeFolder(id: string): Tab[] {
    this.requireFolder(id);
    return this.pagesIn(id)
      .filter((tab) => this.tabs.has(tab.id) && !isAppTab(tab))
      .map((tab) => this.closeTab(tab.id));
  }

  /**
   * Store a blob for a page. The page keeps the returned id (or URL) in its state; once no
   * state or HTML of the page mentions it for PAGE_ASSET_ORPHAN_GRACE_MS, it is deleted.
   */
  savePageAsset(idOrKey: string, input: PageAssetInput): { asset: PageAssetMeta; usage: PageAssetUsage } {
    const tab = this.requireAny(idOrKey);
    assertPageAssetSize(input.data.length);
    const [asset] = this.insertPageAssetDrafts(tab, [
      {
        id: newPageAssetId(),
        name: cleanPageAssetName(input.name),
        mimeType: normalizePageAssetMime(input.mimeType),
        createdAt: Date.now(),
        data: input.data,
      },
    ]);
    return { asset, usage: this.pageAssetUsageOf(tab.id) };
  }

  deletePageAsset(idOrKey: string, assetId: string): PageAssetUsage {
    const tab = this.requireAny(idOrKey);
    if (!isPageAssetId(assetId) || !this.requireDb().deletePageAsset(tab.id, assetId)) {
      throw new Error(`asset not found: ${assetId}`);
    }
    this.refreshPageAssetTotal(tab.id);
    this.emit("page_assets_removed", tab.id);
    return this.pageAssetUsageOf(tab.id);
  }

  listPageAssets(idOrKey: string): { assets: PageAssetMeta[]; usage: PageAssetUsage } {
    const tab = this.requireAny(idOrKey);
    const assets = this.pageAssetTotals.has(tab.id) ? this.requireDb().listPageAssets(tab.id) : [];
    return { assets, usage: this.pageAssetUsageOf(tab.id) };
  }

  /** By asset id alone: page asset URLs do not name their page, so they survive export and import. */
  readPageAsset(assetId: string): { meta: PageAssetMeta; data: Buffer } | undefined {
    if (!this.db || !isPageAssetId(assetId)) {
      return undefined;
    }
    return this.db.readPageAsset(assetId);
  }

  /** One asset that belongs to this page. */
  readTabPageAsset(idOrKey: string, assetId: string): { meta: PageAssetMeta; data: Buffer } {
    const tab = this.requireAny(idOrKey);
    const found = this.readPageAsset(assetId);
    if (!found || found.meta.tabId !== tab.id) {
      throw new Error(`asset not found: ${assetId}`);
    }
    return found;
  }

  pageAssetUsageOf(tabId: string): PageAssetUsage {
    return pageAssetUsage(this.pageAssetTotals.get(tabId));
  }

  /**
   * Safety net behind the per-save checks: drop asset rows whose page row is gone, re-check
   * every page that has assets, and clear agent-attached asset folders of unknown pages.
   */
  sweepAssets(): void {
    if (this.db) {
      try {
        const dangling = this.db.deleteDanglingPageAssets();
        if (dangling) {
          log(`Removed ${dangling} page assets whose page no longer exists`);
          this.pageAssetTotals = this.db.pageAssetTotals();
        }
        this.reconcilePageAssets([...this.pageAssetTotals.keys()]);
      } catch (err) {
        log("Failed to sweep page assets", String(err));
      }
    }
    try {
      cleanupOrphanAssets(this.knownAssetTabIds());
    } catch (err) {
      log("Failed to clean orphan assets", String(err));
    }
  }

  persist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = null;
    }
    if (!this.db) {
      return;
    }
    this.ensureUniqueStripSeqs();
    const upserts: StoredTab[] = [];
    for (const id of this.dirty) {
      const stored = this.storedOf(id);
      if (stored) {
        upserts.push(stored);
      }
    }
    const removedIds = [...this.removed];
    try {
      this.db.save({
        activeId: this.activeId,
        upserts,
        removedIds,
        ...(this.foldersDirty ? { folders: this.collectFolders() } : {}),
        templates: [...this.templates.values()],
        removedTemplateIds: [...this.removedTemplates],
        bindings: this.collectBindings(),
        replaceBindings: true,
        ...(this.spacesDirty ? { spaces: JSON.stringify(this.spaces) } : {}),
      });
      this.spacesDirty = false;
      this.dirty.clear();
      this.removed.clear();
      this.removedTemplates.clear();
      this.templatesDirty = false;
      this.foldersDirty = false;
      // Removed rows took their page assets with them (ON DELETE CASCADE).
      for (const id of removedIds) {
        this.pageAssetTotals.delete(id);
      }
      this.reconcilePageAssets(upserts.map((row) => row.tab.id));
      if (this.persistError) {
        this.persistError = null;
        this.emit("persist_ok");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("Failed to persist board state", message);
      this.persistError = message;
      this.emit("persist_error", message);
      this.schedulePersistRetry();
    }
  }

  closeDb(): void {
    if (this.trashTimer) {
      clearInterval(this.trashTimer);
      this.trashTimer = null;
    }
    if (this.assetSweepTimer) {
      clearInterval(this.assetSweepTimer);
      this.assetSweepTimer = null;
    }
    if (this.assetExpiryTimer) {
      clearTimeout(this.assetExpiryTimer);
      this.assetExpiryTimer = null;
    }
    this.persist();
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = null;
    }
    try {
      this.db?.close();
    } catch (err) {
      log("Failed to close board database", String(err));
    }
    this.db = null;
  }

  private requireOpen(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where !== "open") {
      throw new Error("cannot reorder a closed page");
    }
    return located.tab;
  }

  private requireAny(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    return located.tab;
  }

  private requireFolder(id: string): Folder {
    const folder = this.folders.get(id);
    if (!folder) {
      throw new Error(`folder not found: ${id}`);
    }
    return folder;
  }

  /** Why an agent's title was ignored, or undefined when it applies. */
  private heldTitle(tab: Tab, requested: string, viewer: Viewer): string | undefined {
    if (viewer !== "agent" || requested === tab.title || !this.titleHeld(tab)) {
      return undefined;
    }
    return `renamed by the user ${agoText(Date.now() - tab.userTitleAt!)}`;
  }

  private titleHeld(tab: Tab): boolean {
    return typeof tab.userTitleAt === "number" && Date.now() - tab.userTitleAt < USER_TITLE_HOLD_MS;
  }

  private assertTabRevision(tab: Tab, expected: number | undefined): void {
    const note = this.titleHeld(tab)
      ? `The user renamed this page to "${tab.title}" ${agoText(Date.now() - tab.userTitleAt!)}.`
      : undefined;
    assertRevision(tab.revision, expected, note);
  }

  private planTemplateImport(incoming: Template[]): {
    byFileId: Map<string, Template>;
    created: Template[];
    reused: number;
  } {
    const byFileId = new Map<string, Template>();
    const created: Template[] = [];
    const reused = new Set<string>();
    const byFingerprint = new Map<string, Template>();
    for (const template of this.templates.values()) {
      const fingerprint = templateFingerprint(template);
      if (!byFingerprint.has(fingerprint)) {
        byFingerprint.set(fingerprint, template);
      }
    }
    const reservedKeys = new Set<string>();
    for (const template of incoming) {
      const fingerprint = templateFingerprint(template);
      const sameId = this.templates.get(template.id);
      const match =
        sameId && templateFingerprint(sameId) === fingerprint ? sameId : byFingerprint.get(fingerprint);
      if (match) {
        byFileId.set(template.id, match);
        if (this.templates.has(match.id)) {
          reused.add(match.id);
        }
        continue;
      }
      const idTaken = (id: string) => this.templates.has(id) || created.some((item) => item.id === id);
      const id = idTaken(template.id) ? newTemplateId() : template.id;
      const key = uniqueTemplateKey(this, template.key || undefined, template.title, id, reservedKeys);
      reservedKeys.add(key);
      const fresh: Template = { ...template, id, key };
      // One local copy per built-in: an imported copy only keeps its link when this board has none yet.
      const builtinKey = fresh.source?.builtin;
      if (builtinKey && (this.localCopyOf(builtinKey) || created.some((item) => item.source?.builtin === builtinKey))) {
        delete fresh.source;
      }
      created.push(fresh);
      byFingerprint.set(fingerprint, fresh);
      byFileId.set(template.id, fresh);
    }
    return { byFileId, created, reused: reused.size };
  }

  private buildImportedDraft(
    page: ImportPageInput,
    reserved: Set<string>,
    templates: Map<string, Template>,
    pendingAssets: Map<string, PageAssetDraft[]>
  ): Tab {
    const title = page.title.trim();
    if (!title) {
      throw new Error("title is required");
    }
    if (!page.html || !page.html.trim()) {
      throw new Error("html is required");
    }
    const template = page.template ? templates.get(page.template.templateId) : undefined;
    if (page.template && !template) {
      throw new Error(`template not found: ${page.template.templateId}`);
    }
    const templateValues = template ? parseTemplateValues(template.fields, page.template?.values) : undefined;
    // Importing the same file twice would reuse asset ids, so taken ones get fresh ids and the
    // page's text is rewritten to match.
    const remap = new Map<string, string>();
    const pendingIds = new Set([...pendingAssets.values()].flat().map((asset) => asset.id));
    const pageAssets = (page.pageAssets ?? []).map((asset) => {
      if (!pendingIds.has(asset.id) && !this.db?.pageAssetExists(asset.id)) {
        return asset;
      }
      const id = newPageAssetId();
      remap.set(asset.id, id);
      return { ...asset, id };
    });
    const pageHtml = remapPageAssetRefs(page.html, remap);
    const pageState = page.state && remap.size
      ? (JSON.parse(remapPageAssetRefs(JSON.stringify(page.state), remap)) as BoardState)
      : page.state;
    const html = wrapHtml(title, pageHtml);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    if (pageState) {
      const stateBytes = Buffer.byteLength(JSON.stringify(pageState), "utf8");
      if (stateBytes > MAX_STATE_BYTES) {
        throw new Error(`state is too large (${stateBytes} bytes, max ${MAX_STATE_BYTES})`);
      }
    }
    const id = newId();
    let assets: TabAsset[] = [];
    try {
      assets = applyAssets(id, [], page.assets);
    } catch (err) {
      deleteTabAssets(id);
      throw err;
    }
    const now = Date.now();
    const requested = page.key && pageKey(page.key) !== WELCOME_KEY ? page.key : undefined;
    const tab: Tab = {
      id,
      key: uniqueKey(this, requested, title, id, reserved),
      title,
      html,
      pinned: Boolean(page.pinned),
      createdAt: finiteTs(page.createdAt) ?? now,
      updatedAt: finiteTs(page.updatedAt) ?? now,
      libPos: 0,
      stripSeq: this.nextSeq(),
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      eventSeq: 0,
      events: [],
      assets,
      ...(page.agentHidden ? { agentHidden: true } : {}),
      ...(page.provenance ? { provenance: page.provenance } : {}),
    };
    seedState(tab, pageState);
    if (pageAssets.length) {
      pendingAssets.set(id, pageAssets);
    }
    if (template && page.template && templateValues) {
      applyBinding(tab, { ...page.template, tabId: id, templateId: template.id, values: templateValues });
    }
    return tab;
  }

  /** Imported pages go to the top of their folder, keeping the file's order. */
  private placeImported(drafts: Tab[], pages: ImportPageInput[]): void {
    const groups = new Map<string | null, Array<{ tab: Tab; libPos: number; index: number }>>();
    drafts.forEach((tab, index) => {
      const page = pages[index];
      const folderId = page.folderPath ? this.ensureFolderPath(page.folderPath) : null;
      if (folderId) {
        tab.folderId = folderId;
      }
      const list = groups.get(folderId) ?? [];
      list.push({ tab, libPos: finiteTs(page.libPos) ?? index, index });
      groups.set(folderId, list);
    });
    for (const [folderId, list] of groups) {
      list.sort((a, b) => a.libPos - b.libPos || a.index - b.index);
      const top = this.pagesIn(folderId)[0]?.libPos ?? 0;
      list.forEach((item, i) => {
        item.tab.libPos = top - list.length + i;
      });
    }
  }

  private locate(idOrKey: string): Located | undefined {
    const openById = this.tabs.get(idOrKey);
    if (openById) {
      return { tab: openById, where: "open" };
    }
    const closedById = this.closed.get(idOrKey);
    if (closedById) {
      return { tab: closedById, where: "closed" };
    }
    const key = pageKey(idOrKey);
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab && tab.key === key) {
        return { tab, where: "open" };
      }
    }
    for (const tab of this.closed.values()) {
      if (tab.key === key) {
        return { tab, where: "closed" };
      }
    }
    return undefined;
  }

  private locateFor(idOrKey: string, viewer: Viewer): Located | undefined {
    const located = this.locate(idOrKey);
    return located && visibleTo(located.tab, viewer) ? located : undefined;
  }

  private setPinned(tab: Tab, pinned: boolean): void {
    tab.pinned = pinned && !tab.temp;
    this.rebuildOrder();
  }

  private restoreTab(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    this.closed.delete(tab.id);
    return this.reopen(tab, placement, activate);
  }

  private reopen(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    if (this.tabs.has(tab.id) || this.closed.has(tab.id)) {
      throw new Error(`tab already open: ${tab.id}`);
    }
    this.claimKey(tab);
    delete tab.closedAt;
    switch (placement) {
      case "append":
        tab.stripSeq = this.nextSeq();
        break;
      case "index":
        break;
      default: {
        const _never: never = placement;
        return _never;
      }
    }
    this.tabs.set(tab.id, tab);
    this.rebuildOrder();
    const at = this.order.indexOf(tab.id);
    if (activate) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), at, { activate, structural: true });
    if (activate) {
      this.emit("tab_focused", tab.id);
    }
    return tab;
  }

  /** Put a deleted batch back where it was: folders first, then pages open or closed as they were. */
  private restoreBatch(batch: DeletedBatch): Tab | null {
    for (const folder of batch.folders) {
      if (folder.parentId && !this.folders.has(folder.parentId) && !batch.folders.some((f) => f.id === folder.parentId)) {
        folder.parentId = null;
      }
      this.folders.set(folder.id, folder);
    }
    if (batch.folders.length) {
      this.foldersDirty = true;
      this.emitFolders();
    }
    let focus: Tab | null = null;
    for (const tab of batch.tabs) {
      if (tab.folderId && !this.folders.has(tab.folderId)) {
        delete tab.folderId;
      }
      if (typeof tab.closedAt === "number") {
        this.claimKey(tab);
        this.closed.set(tab.id, tab);
        this.markDirty(tab.id);
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
        focus ??= tab;
      } else {
        const reopened = this.reopen(tab, "index", false);
        if (!focus || this.closed.has(focus.id)) {
          focus = reopened;
        }
      }
    }
    if (focus && this.tabs.has(focus.id)) {
      this.activeId = focus.id;
      this.emit("tab_focused", focus.id);
    }
    this.persistSoon();
    return focus;
  }

  /**
   * A page in the Trash gives up its key when a new page wants it: the key names the page an
   * agent or the user is working with now. Restoring the trashed page later gives it a free key
   * (claimKey). Without this the key stays taken in the database and every save fails.
   */
  releaseTrashedKey(key: string): void {
    for (const batch of this.deleted) {
      for (const tab of batch.tabs) {
        if (tab.key === key) {
          tab.key = `${key}-${tab.id.slice(2)}`;
          this.markDirty(tab.id);
        }
      }
    }
  }

  private claimKey(tab: Tab): void {
    const keyOwner = this.locate(tab.key);
    if (keyOwner && keyOwner.tab.id !== tab.id) {
      tab.key = uniqueKey(this, tab.key, tab.title, tab.id);
    }
  }

  /** Take a page out of the strip or the closed set without deciding where it goes. */
  private detach(located: Located): void {
    const tab = located.tab;
    if (located.where === "open") {
      this.tabs.delete(tab.id);
      delete tab.closedAt;
    } else {
      this.closed.delete(tab.id);
    }
    this.markDirty(tab.id);
  }

  /** Drop an in-app page (help) without closing it into the Library or keeping it on the Ctrl+Z stack. */
  private discardAppTab(tab: Tab): Tab {
    const wasActive = this.activeId === tab.id;
    const wasOpen = this.tabs.has(tab.id);
    const prevOrder = this.order;
    this.tabs.delete(tab.id);
    this.closed.delete(tab.id);
    this.rebuildOrder();
    delete tab.closedAt;
    if (wasActive) {
      this.activeId = this.neighborOf(prevOrder, tab.id);
    }
    this.removed.add(tab.id);
    this.dirty.delete(tab.id);
    deleteTabAssets(tab.id);
    this.persistSoon();
    this.emit("tab_deleted", tab.id);
    if (wasOpen) {
      this.emit("tab_focused", this.activeId);
    }
    return tab;
  }

  private liftFolder(folder: Folder): Tab[] {
    const parentId = folder.parentId;
    const siblings = this.foldersIn(parentId);
    const at = siblings.findIndex((item) => item.id === folder.id);
    const lo = siblings[at - 1]?.pos ?? folder.pos - 1;
    const hi = siblings[at + 1]?.pos ?? folder.pos + 1;
    const children = this.foldersIn(folder.id);
    children.forEach((child, i) => {
      this.pinDiskPath(child);
      child.parentId = parentId;
      child.pos = lo + ((hi - lo) * (i + 1)) / (children.length + 1);
    });
    const pages = this.pagesIn(folder.id);
    const last = this.pagesIn(parentId).at(-1)?.libPos ?? 0;
    pages.forEach((tab, i) => {
      if (parentId) {
        tab.folderId = parentId;
      } else {
        delete tab.folderId;
      }
      tab.libPos = last + 1 + i;
      this.markDirty(tab.id);
    });
    this.folders.delete(folder.id);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    for (const tab of pages) {
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    }
    return pages;
  }

  private deleteFolderTree(folder: Folder): Tab[] {
    const ids = this.subtreeFolderIds(folder.id);
    const folders = this.listFolders().filter((item) => ids.has(item.id));
    folders.sort((a, b) => this.folderDepth(a) - this.folderDepth(b));
    const pages = this.libraryTabs().filter((tab) => tab.folderId && ids.has(tab.folderId));
    const deleted = this.deleteMany(pages.map((tab) => tab.id));
    let batch = this.deleted[this.deleted.length - 1];
    if (!deleted.length || !batch || batch.tabs[0]?.id !== deleted[0].id) {
      batch = { id: newBatchId(), deletedAt: this.stamp(), tabs: [], folders: [] };
      this.pushDeleted(batch);
    }
    batch.folders.push(...folders);
    for (const item of folders) {
      this.folders.delete(item.id);
    }
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return deleted;
  }

  private folderDepth(folder: Folder): number {
    let depth = 0;
    let at = folder.parentId ? this.folders.get(folder.parentId) : undefined;
    while (at && depth < 64) {
      depth += 1;
      at = at.parentId ? this.folders.get(at.parentId) : undefined;
    }
    return depth;
  }

  private subtreeFolderIds(rootId: string): Set<string> {
    const ids = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of this.folders.values()) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  /** Walks a "A/B" path from the root, creating folders that don't exist yet. */
  private ensureFolderPath(path: string): string | null {
    let parentId: string | null = null;
    for (const name of splitFolderPath(path)) {
      const match: Folder | undefined = this.foldersIn(parentId).find((folder) => sameName(folder.name, name));
      if (match) {
        parentId = match.id;
        continue;
      }
      const now = Date.now();
      const folder: Folder = {
        id: newFolderId(),
        parentId,
        name: cleanFolderName(name),
        pos: this.folderPosAt(parentId, Number.POSITIVE_INFINITY),
        createdAt: now,
        updatedAt: now,
      };
      this.folders.set(folder.id, folder);
      this.foldersDirty = true;
      parentId = folder.id;
    }
    return parentId;
  }

  private libraryTabs(): Tab[] {
    return [...this.tabs.values(), ...this.closed.values()].filter((tab) => !isAppTab(tab));
  }

  private pagesIn(folderId: string | null, exceptId?: string): Tab[] {
    return this.libraryTabs()
      .filter((tab) => (tab.folderId ?? null) === folderId && tab.id !== exceptId)
      .sort(byLibPos);
  }

  /** Root first, then each child down to `folderId`. */
  private folderAncestors(folderId: string | null): Array<string | null> {
    const chain: Array<string | null> = [];
    if (folderId) {
      const seen = new Set<string>();
      let at: string | undefined = folderId;
      while (at && !seen.has(at)) {
        seen.add(at);
        chain.push(at);
        at = this.folders.get(at)?.parentId ?? undefined;
      }
    }
    chain.push(null);
    chain.reverse();
    return chain;
  }

  private foldersIn(parentId: string | null, exceptId?: string): Folder[] {
    return this.listFolders().filter((folder) => folder.parentId === parentId && folder.id !== exceptId);
  }

  /** Pages depth-first: each folder's subfolders, then its own pages. */
  private treeOrder(): Tab[] {
    const out: Tab[] = [];
    const walk = (folderId: string | null) => {
      for (const folder of this.foldersIn(folderId)) {
        walk(folder.id);
      }
      out.push(...this.pagesIn(folderId));
    };
    walk(null);
    return out;
  }

  private pagePosAt(folderId: string | null, index: number, exceptId?: string): number {
    let siblings = this.pagesIn(folderId, exceptId);
    let pos = slotPos(siblings.map((tab) => tab.libPos), index);
    if (Number.isNaN(pos)) {
      siblings.forEach((tab, i) => {
        tab.libPos = i;
        this.markDirty(tab.id);
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
      });
      siblings = this.pagesIn(folderId, exceptId);
      pos = slotPos(siblings.map((tab) => tab.libPos), index);
    }
    return pos;
  }

  private folderPosAt(parentId: string | null, index: number, exceptId?: string): number {
    const siblings = this.foldersIn(parentId, exceptId);
    let pos = slotPos(siblings.map((folder) => folder.pos), index);
    if (Number.isNaN(pos)) {
      siblings.forEach((folder, i) => {
        folder.pos = i;
      });
      this.foldersDirty = true;
      pos = slotPos(siblings.map((folder) => folder.pos), index);
    }
    return pos;
  }

  /** Pages pointing at a folder that no longer exists go to the root; orphaned folders too. */
  private repairLibraryRefs(): void {
    for (const folder of this.folders.values()) {
      if (folder.parentId && (!this.folders.has(folder.parentId) || folder.parentId === folder.id)) {
        folder.parentId = null;
        this.foldersDirty = true;
      }
    }
    for (const tab of this.libraryTabs()) {
      if (tab.folderId && !this.folders.has(tab.folderId)) {
        delete tab.folderId;
        this.markDirty(tab.id);
      }
    }
  }

  private emitFolders(): void {
    this.emit("folders", this.listFolders());
    // Folder links, moves and deletes change which disk folders are watched (#707).
    this.diskWatcher?.syncSoon();
  }

  /** The nearest still-open tab right of `id` in `prevOrder`, else the nearest to its left. */
  private neighborOf(prevOrder: string[], id: string): string | null {
    const idx = prevOrder.indexOf(id);
    if (idx === -1) {
      return this.order[this.order.length - 1] ?? null;
    }
    for (let i = idx + 1; i < prevOrder.length; i++) {
      if (this.tabs.has(prevOrder[i])) {
        return prevOrder[i];
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (this.tabs.has(prevOrder[i])) {
        return prevOrder[i];
      }
    }
    return null;
  }

  private rebuildOrder(): void {
    this.order = [...this.tabs.values()]
      .sort((a, b) => {
        const ap = a.pinned ? 0 : 1;
        const bp = b.pinned ? 0 : 1;
        if (ap !== bp) {
          return ap - bp;
        }
        return a.stripSeq - b.stripSeq;
      })
      .map((tab) => tab.id);
  }

  private nextSeq(): number {
    this.lastSeq += 1;
    return this.lastSeq;
  }

  private persistSoon(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }

  private schedulePersistRetry(): void {
    if (this.persistRetryTimer || !this.db) {
      return;
    }
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = null;
      this.persist();
    }, 2000);
  }

  /** Later copies of a seq get a new number so SQLite UNIQUE(strip_seq) cannot stick. */
  private ensureUniqueStripSeqs(): void {
    const seen = new Set<number>();
    const tabs = [
      ...this.order.map((id) => this.tabs.get(id)),
      ...this.closed.values(),
      ...this.deleted.flatMap((batch) => batch.tabs),
    ];
    let changed = false;
    for (const tab of tabs) {
      if (!tab) {
        continue;
      }
      if (seen.has(tab.stripSeq)) {
        tab.stripSeq = this.nextSeq();
        this.markDirty(tab.id);
        changed = true;
      } else {
        seen.add(tab.stripSeq);
      }
    }
    if (changed) {
      this.rebuildOrder();
    }
  }

  private locateTemplate(idOrKey: string): Template | undefined {
    const byId = this.templates.get(idOrKey);
    if (byId) {
      return byId;
    }
    const key = normalizeKey(idOrKey);
    for (const template of this.templates.values()) {
      if (template.key === key || template.id === idOrKey) {
        return template;
      }
    }
    return undefined;
  }

  private locateBuiltin(idOrKey: string): Template | undefined {
    const key = isBuiltinId(idOrKey) ? idOrKey.slice(BUILTIN_ID_PREFIX.length) : normalizeKey(idOrKey);
    return this.builtins.find((builtin) => builtin.key === key);
  }

  private localCopyOf(builtinKey: string): Template | undefined {
    for (const template of this.templates.values()) {
      if (template.source?.builtin === builtinKey) {
        return template;
      }
    }
    return undefined;
  }

  /**
   * Read templates/builtin again (the dev watcher calls this when a file changes), then update
   * unedited copies the same way a version upgrade does and flag edited ones with builtinUpdate.
   * Returns the keys of the built-ins that changed. A built-in that fails to load keeps the old set.
   */
  reloadBuiltins(dir?: string): string[] {
    let next: Template[];
    try {
      next = loadBuiltinTemplates(dir);
    } catch (err) {
      log("Built-in templates not reloaded", (err as Error).message);
      return [];
    }
    // The fingerprint leaves out the guide and actions, which also come from the built-in.
    const version = (builtin: Template) =>
      templateFingerprint(builtin) + JSON.stringify([builtin.guide ?? "", builtin.agentActions ?? []]);
    const before = new Map(this.builtins.map((builtin) => [builtin.key, version(builtin)]));
    const changed = next
      .filter((builtin) => before.get(builtin.key) !== version(builtin))
      .map((builtin) => builtin.key);
    const removed = [...before.keys()].some((key) => !next.some((builtin) => builtin.key === key));
    if (!changed.length && !removed) {
      return [];
    }
    this.builtins = next;
    this.adoptBuiltinCopies();
    this.syncBuiltinCopies();
    // Edited copies are not synced; refresh their meta so builtinUpdate shows.
    for (const key of changed) {
      const copy = this.localCopyOf(key);
      if (copy) {
        this.emit("template_upserted", this.templateMeta(copy, this.instanceCount(copy.id)));
      }
    }
    this.emit("builtin_templates", this.listBuiltinTemplates());
    if (this.templatesDirty) {
      this.persistSoon();
    }
    return changed;
  }

  /**
   * Bring unedited local copies up to date with a changed built-in, and re-render their pages.
   * A copy the user edited, or a built-in whose stateVersion changed, is left for an agent to update.
   */
  private syncBuiltinCopies(): void {
    for (const builtin of this.builtins) {
      const copy = this.localCopyOf(builtin.key);
      if (!copy?.source) {
        continue;
      }
      const latest = templateFingerprint(builtin);
      if (copy.source.fingerprint === latest) {
        continue;
      }
      // Already matches the built-in (e.g. the same change was made to both): just record that.
      if (templateFingerprint(copy) === latest) {
        copy.source = { builtin: builtin.key, fingerprint: latest };
        this.markTemplateDirty(copy.id);
        continue;
      }
      if (templateFingerprint(copy) !== copy.source.fingerprint || copy.stateVersion !== builtin.stateVersion) {
        continue;
      }
      copy.title = builtin.title;
      copy.description = builtin.description;
      copy.html = builtin.html;
      copy.fields = structuredClone(builtin.fields);
      copy.titleTemplate = builtin.titleTemplate;
      copy.initialState = structuredClone(builtin.initialState);
      copy.search = structuredClone(builtin.search);
      if (builtin.pin === false) {
        copy.pin = false;
      } else {
        delete copy.pin;
      }
      copy.source = { builtin: builtin.key, fingerprint: latest };
      copy.updatedAt = Date.now();
      this.markTemplateDirty(copy.id);
      this.refreshTemplateInstances(copy, false);
      this.emit("template_upserted", this.templateMeta(copy, this.instanceCount(copy.id)));
    }
  }

  /** Link a local template identical to a built-in (e.g. the one it was made from), so opening the built-in reuses it. */
  private adoptBuiltinCopies(): void {
    for (const builtin of this.builtins) {
      if (this.localCopyOf(builtin.key)) {
        continue;
      }
      const fingerprint = templateFingerprint(builtin);
      const twin = [...this.templates.values()].find(
        (template) => !template.source && templateFingerprint(template) === fingerprint
      );
      if (twin) {
        twin.source = { builtin: builtin.key, fingerprint };
        this.markTemplateDirty(twin.id);
      }
    }
  }

  private requireTemplate(idOrKey: string): Template {
    const template = this.locateTemplate(idOrKey);
    if (!template) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    return template;
  }

  private instanceCount(templateId: string, viewer: Viewer = "user"): number {
    let count = 0;
    for (const tab of this.allTabs()) {
      if (tab.templateId === templateId && visibleTo(tab, viewer)) {
        count += 1;
      }
    }
    return count;
  }

  private allTabs(): Tab[] {
    return [...this.tabs.values(), ...this.closed.values(), ...this.deleted.flatMap((batch) => batch.tabs)];
  }

  private collectBindings(): TemplateBinding[] {
    const bindings: TemplateBinding[] = [];
    for (const tab of this.allTabs()) {
      if (!tab.templateId) {
        continue;
      }
      bindings.push({
        tabId: tab.id,
        templateId: tab.templateId,
        values: tab.templateValues ?? {},
        stateVersion: tab.templateStateVersion ?? 0,
        compatible: tab.templateCompatible !== false,
        ...(tab.templateIncompatibleReason ? { reason: tab.templateIncompatibleReason } : {}),
      });
    }
    return bindings;
  }

  private collectFolders(): StoredFolder[] {
    return [
      ...[...this.folders.values()].map((folder) => ({ folder })),
      ...this.deleted.flatMap((batch) =>
        batch.folders.map((folder) => ({ folder, deletedAt: batch.deletedAt, deletedBatch: batch.id }))
      ),
    ];
  }

  private markTemplateDirty(id: string): void {
    this.templatesDirty = true;
    this.removedTemplates.delete(id);
  }

  private templateLabel(tab: Tab): string {
    if (!tab.templateId) {
      return "a template";
    }
    const template = this.templates.get(tab.templateId);
    return template ? template.key : tab.templateId;
  }

  private refreshTemplateInstances(template: Template, versionChanged: boolean): void {
    for (const tab of this.allTabs()) {
      if (tab.templateId !== template.id) {
        continue;
      }
      const values = mergeTemplateValues(template.fields, tab.templateValues);
      const compatible = versionChanged ? false : tab.templateCompatible !== false;
      const reason = versionChanged
        ? "The template changed and this page's data may no longer match. Ask an agent to update it."
        : tab.templateIncompatibleReason;
      this.applyTemplateRender(tab, template, values, compatible, reason);
      this.markDirty(tab.id);
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true, template: true });
    }
  }

  private applyTemplateRender(
    tab: Tab,
    template: Template,
    values: TemplateValues,
    compatible: boolean,
    reason?: string
  ): void {
    // A template that doesn't build the title from its fields leaves the page's own title (a rename) alone.
    const title = templateSetsTitle(template) ? renderTemplateTitle(template, values) : tab.title;
    tab.title = title;
    tab.html = this.renderBoundHtml(template, title, values);
    tab.updatedAt = Date.now();
    tab.revision += 1;
    this.bindTab(tab, template, values, compatible, reason);
  }

  private renderBoundHtml(template: Template, title: string, values: TemplateValues): string {
    const html = wrapHtml(title, substituteTemplate(template.html, values, true));
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    return html;
  }

  private bindTab(
    tab: Tab,
    template: Template,
    values: TemplateValues,
    compatible: boolean,
    reason?: string
  ): void {
    tab.templateId = template.id;
    tab.templateValues = values;
    tab.templateStateVersion = template.stateVersion;
    tab.templateCompatible = compatible;
    if (!compatible && reason) {
      tab.templateIncompatibleReason = reason;
    } else if (compatible) {
      delete tab.templateIncompatibleReason;
    }
  }

  private unlinkTemplate(tab: Tab): void {
    delete tab.templateId;
    delete tab.templateValues;
    delete tab.templateStateVersion;
    delete tab.templateCompatible;
    delete tab.templateIncompatibleReason;
    this.markDirty(tab.id);
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
  }

  private applyResolveIncompatibility(tab: Tab, resolve?: boolean): boolean {
    if (!resolve || !tab.templateId || tab.templateCompatible !== false) {
      return false;
    }
    const template = this.templates.get(tab.templateId);
    tab.templateCompatible = true;
    delete tab.templateIncompatibleReason;
    if (template) {
      tab.templateStateVersion = template.stateVersion;
    }
    return true;
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    this.removed.delete(id);
  }

  private storedOf(id: string): StoredTab | undefined {
    const open = this.tabs.get(id);
    if (open) {
      return { tab: open, status: "open" };
    }
    const closed = this.closed.get(id);
    if (closed) {
      return { tab: closed, status: "closed" };
    }
    for (const batch of this.deleted) {
      const tab = batch.tabs.find((item) => item.id === id);
      if (tab) {
        return { tab, status: "deleted", deletedAt: batch.deletedAt, deletedBatch: batch.id };
      }
    }
    return undefined;
  }

  private pushDeleted(batch: DeletedBatch): void {
    this.deleted.push(batch);
    for (const tab of batch.tabs) {
      this.markDirty(tab.id);
    }
    this.expireTrash();
    this.emit("trash");
  }

  /** Drop batches older than the Trash keeps. True when something went. */
  private expireTrash(): boolean {
    const cutoff = Date.now() - TRASH_TTL_MS;
    let dropped = false;
    while (this.deleted.length && this.deleted[0].deletedAt < cutoff) {
      this.dropForever(this.deleted.shift()!);
      dropped = true;
    }
    if (dropped) {
      this.emit("trash");
    }
    return dropped;
  }

  /** Forget pages and folders already taken out of the Trash. */
  private dropForever(gone: DeletedBatch): void {
    for (const tab of gone.tabs) {
      this.removed.add(tab.id);
      this.dirty.delete(tab.id);
      if (!this.tabs.has(tab.id) && !this.closed.has(tab.id)) {
        deleteTabAssets(tab.id);
        if (tab.file?.copy) {
          removeCopies(tab.id);
        }
      }
    }
    if (gone.folders.length) {
      this.foldersDirty = true;
    }
  }

  /** Remove a page, or a folder subtree and its pages, from its Trash batch and return them as a batch. */
  private takeFromTrash(id: string): DeletedBatch {
    const at = this.deleted.findIndex(
      (batch) => batch.tabs.some((tab) => tab.id === id) || batch.folders.some((folder) => folder.id === id)
    );
    if (at === -1) {
      throw new Error(`not in the trash: ${id}`);
    }
    const batch = this.deleted[at];
    const part: DeletedBatch = { id: batch.id, deletedAt: batch.deletedAt, tabs: [], folders: [] };
    const folderIds = new Set<string>();
    if (batch.folders.some((folder) => folder.id === id)) {
      folderIds.add(id);
      let grew = true;
      while (grew) {
        grew = false;
        for (const folder of batch.folders) {
          if (!folderIds.has(folder.id) && folder.parentId && folderIds.has(folder.parentId)) {
            folderIds.add(folder.id);
            grew = true;
          }
        }
      }
      part.folders = batch.folders.filter((folder) => folderIds.has(folder.id));
      part.tabs = batch.tabs.filter((tab) => tab.folderId && folderIds.has(tab.folderId));
    } else {
      part.tabs = batch.tabs.filter((tab) => tab.id === id);
    }
    batch.folders = batch.folders.filter((folder) => !part.folders.includes(folder));
    batch.tabs = batch.tabs.filter((tab) => !part.tabs.includes(tab));
    if (!batch.tabs.length && !batch.folders.length) {
      this.deleted.splice(at, 1);
    }
    if (part.folders.length) {
      this.foldersDirty = true;
    }
    return part;
  }

  private stamp(): number {
    const now = Date.now();
    const next = Math.max(now, this.lastStamp + 1);
    this.lastStamp = next;
    return next;
  }

  private requireDb(): BoardDb {
    if (!this.db) {
      throw new Error("board database is not open");
    }
    return this.db;
  }

  /** Checks room, writes the page row first if it is new (asset rows point at it), then the assets. */
  private insertPageAssetDrafts(tab: Tab, drafts: PageAssetDraft[]): PageAssetMeta[] {
    const db = this.requireDb();
    const current = this.pageAssetTotals.get(tab.id) ?? { count: 0, bytes: 0 };
    const adding = drafts.reduce((sum, draft) => sum + draft.data.length, 0);
    assertPageAssetRoom(current, drafts.length, adding);
    if (this.dirty.has(tab.id)) {
      this.persist();
      if (this.dirty.has(tab.id)) {
        throw new Error(`could not save the page before its assets: ${this.persistError ?? "unknown error"}`);
      }
    }
    db.insertPageAssets(tab.id, drafts);
    const next = { count: current.count + drafts.length, bytes: current.bytes + adding };
    this.pageAssetTotals.set(tab.id, next);
    this.scheduleAssetExpiry(Math.min(...drafts.map((draft) => draft.createdAt)) + PAGE_ASSET_ORPHAN_GRACE_MS);
    const usage = pageAssetUsage(next);
    if (usage.warning) {
      this.emit("page_asset_warning", tab, usage);
    }
    return drafts.map((draft) => ({
      id: draft.id,
      tabId: tab.id,
      name: draft.name,
      mimeType: draft.mimeType,
      bytes: draft.data.length,
      createdAt: draft.createdAt,
      orphanedAt: draft.createdAt,
    }));
  }

  /**
   * Read the agent's files and swap each `asset:<name>` string in the state for the URL its
   * asset will have. Nothing is stored yet, so a state that turns out too large leaves nothing behind.
   */
  /** Swap "asset:<name>" strings in a write (ops or a state object) for the stored files' URLs. */
  private prepareStateAssets(
    tab: Tab,
    value: unknown,
    files: PageAssetFile[]
  ): { value: unknown; drafts: PageAssetDraft[] } {
    const now = Date.now();
    const urls = new Map<string, string>();
    const drafts: PageAssetDraft[] = [];
    for (const file of files) {
      const read = readPageAssetFile(file);
      const key = read.name.toLowerCase();
      if (urls.has(key)) {
        throw new Error(`duplicate asset name: ${read.name}`);
      }
      const draft: PageAssetDraft = { id: newPageAssetId(), createdAt: now, ...read };
      urls.set(key, pageAssetUrl(draft.id));
      drafts.push(draft);
    }
    assertPageAssetRoom(
      this.pageAssetTotals.get(tab.id) ?? { count: 0, bytes: 0 },
      drafts.length,
      drafts.reduce((sum, draft) => sum + draft.data.length, 0)
    );
    const used = new Set<string>();
    const missing = new Set<string>();
    const next = substituteStateAssets(value, urls, used, missing);
    const unused = drafts.filter((draft) => !used.has(draft.name.toLowerCase())).map((draft) => draft.name);
    if (missing.size || unused.length) {
      const parts = [
        ...(missing.size ? [`state refers to ${[...missing].map((name) => `asset:${name}`).join(", ")} but no such file was passed`] : []),
        ...(unused.length ? [`no state value is exactly asset:<name> for ${unused.join(", ")}`] : []),
      ];
      throw new Error(`${parts.join("; ")}. Put "asset:<name>" as a whole string value where each file's URL should go.`);
    }
    return { value: next, drafts };
  }

  /** Asset rows point at page rows, so imported pages are written before their assets. */
  private insertImportedPageAssets(pending: Map<string, PageAssetDraft[]>): void {
    this.persist();
    const db = this.requireDb();
    for (const [tabId, assets] of pending) {
      try {
        db.insertPageAssets(tabId, assets);
        this.refreshPageAssetTotal(tabId);
      } catch (err) {
        log(`Failed to import page assets for ${tabId}`, String(err));
      }
    }
    // Imported assets start orphaned; check them against their pages right away.
    this.reconcilePageAssets(pending.keys());
  }

  /** Pages whose rows were deleted are skipped; the cascade already took their assets. */
  private reconcilePageAssets(ids: Iterable<string>): void {
    if (!this.db) {
      return;
    }
    const now = Date.now();
    let next: number | null = null;
    try {
      for (const id of ids) {
        if (!this.pageAssetTotals.has(id)) {
          continue;
        }
        const tab = this.storedOf(id)?.tab;
        if (!tab) {
          continue;
        }
        const refs = collectPageAssetRefs(tab.html, JSON.stringify(tab.state));
        const result = this.db.reconcilePageAssets(id, refs, now, PAGE_ASSET_ORPHAN_GRACE_MS);
        if (result.deleted) {
          this.refreshPageAssetTotal(id);
          this.emit("page_assets_removed", id);
        }
        if (result.nextExpiry !== null) {
          next = Math.min(next ?? Infinity, result.nextExpiry);
        }
      }
    } catch (err) {
      log("Failed to check page assets", String(err));
    }
    if (next !== null) {
      this.scheduleAssetExpiry(next);
    }
  }

  /** One timer for the earliest orphan to run out of grace; firing re-checks every page with assets. */
  private scheduleAssetExpiry(at: number): void {
    if (this.assetExpiryTimer && this.assetExpiryAt <= at) {
      return;
    }
    if (this.assetExpiryTimer) {
      clearTimeout(this.assetExpiryTimer);
    }
    this.assetExpiryAt = at;
    this.assetExpiryTimer = setTimeout(() => {
      this.assetExpiryTimer = null;
      this.assetExpiryAt = 0;
      this.reconcilePageAssets([...this.pageAssetTotals.keys()]);
    }, Math.max(0, at - Date.now()) + 1000);
    this.assetExpiryTimer.unref?.();
  }

  private refreshPageAssetTotal(tabId: string): void {
    const total = this.db?.pageAssetTotal(tabId);
    if (total && total.count) {
      this.pageAssetTotals.set(tabId, total);
    } else {
      this.pageAssetTotals.delete(tabId);
    }
  }

  private knownAssetTabIds(): string[] {
    return this.allTabs().map((tab) => tab.id);
  }
}

function newId(): string {
  return "t_" + randomBytes(4).toString("hex");
}

function newFolderId(): string {
  return "f_" + randomBytes(4).toString("hex");
}

function newBatchId(): string {
  return "d_" + randomBytes(4).toString("hex");
}

function byLibPos(a: Tab, b: Tab): number {
  return a.libPos - b.libPos;
}

function byClosedDesc(a: Tab, b: Tab): number {
  return (b.closedAt ?? 0) - (a.closedAt ?? 0);
}

/**
 * A position for inserting at `index` among sorted `positions`. NaN when two
 * neighbours are too close to split, which tells the caller to renumber.
 */
function slotPos(positions: number[], index: number): number {
  if (!positions.length) {
    return 0;
  }
  if (index <= 0) {
    return positions[0] - 1;
  }
  if (index >= positions.length) {
    return positions[positions.length - 1] + 1;
  }
  const a = positions[index - 1];
  const b = positions[index];
  const mid = (a + b) / 2;
  return mid > a && mid < b ? mid : Number.NaN;
}

function splitFolderPath(path: string): string[] {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** A disk path to compare by (Windows paths ignore case), as samePath does. */
function normPath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Every file in an Open folder scan. */
function folderEntryFiles(entry: FolderEntry): string[] {
  return entry.kind === "file" ? [entry.path] : entry.children.flatMap(folderEntryFiles);
}

function cleanFolderName(name: string): string {
  const cleaned = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
  return cleaned || "New folder";
}

function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  return `${Math.round(min / 60)}h ago`;
}

function withStateDefaults(tab: Tab): Tab {
  const events = normalizeEvents(tab.events);
  return {
    ...tab,
    libPos: typeof tab.libPos === "number" && Number.isFinite(tab.libPos) ? tab.libPos : 0,
    stripSeq: typeof tab.stripSeq === "number" ? tab.stripSeq : 0,
    state: isPlainObject(tab.state) ? tab.state : {},
    stateRevision: typeof tab.stateRevision === "number" ? tab.stateRevision : 0,
    stateUpdatedAt: typeof tab.stateUpdatedAt === "number" ? tab.stateUpdatedAt : 0,
    eventSeq: Math.max(typeof tab.eventSeq === "number" ? tab.eventSeq : 0, events.at(-1)?.seq ?? 0),
    events,
    assets: normalizeTabAssets(tab.assets),
  };
}



function applyAssets(tabId: string, current: TabAsset[], incoming: UpsertInput["assets"]): TabAsset[] {
  if (!incoming?.length) {
    return current;
  }
  return writePreparedAssets(tabId, current, incoming);
}

function replaceOrEdit(tab: Tab, input: { edits?: HtmlEdit[]; html?: string }): HtmlEditResult {
  if (input.html !== undefined) {
    if (input.edits?.length) {
      throw new Error("pass either edits or html, not both");
    }
    if (!input.html.trim()) {
      throw new Error("html is required");
    }
    return { html: wrapHtml(tab.title, input.html), applied: 1 };
  }
  return applyEdits(tab.html, input.edits ?? []);
}

/** Initial state only lands on a tab that has none, so re-showing a page never resets what the user changed. */
function seedState(tab: Tab, state: BoardState | undefined): void {
  if (!state || !isPlainObject(state) || tab.stateRevision > 0) {
    return;
  }
  tab.state = { ...state };
  tab.stateRevision = 1;
  tab.stateUpdatedAt = Date.now();
}

function actorFromCaller(caller: ActionCaller): PageActor | undefined {
  if (caller.by !== "agent") {
    return undefined;
  }
  const raw = caller.label?.trim() ?? "";
  const title =
    raw && raw !== "agent" && raw !== "user" ? raw.replace(/^Scribe chat:\s*/, "").slice(0, 120) : undefined;
  return {
    at: Date.now(),
    ...(caller.thread ? { thread: caller.thread } : {}),
    ...(title ? { title } : {}),
  };
}

function newTemplateId(): string {
  return "tpl_" + randomBytes(4).toString("hex");
}

function uniqueTemplateKey(
  store: BoardStore,
  requested: string | undefined,
  title: string,
  id: string,
  reserved: Set<string> = new Set()
): string {
  const taken = (key: string) => Boolean(store.getTemplate(key)) || reserved.has(key);
  if (requested) {
    const key = normalizeKey(requested);
    if (key && !taken(key)) {
      return key;
    }
    if (key) {
      return `${key}-${id.slice(4)}`;
    }
  }
  const base = normalizeKey(title) || "template";
  if (!taken(base)) {
    return base;
  }
  return `${base}-${id.slice(4)}`;
}

function applyBinding(tab: Tab, binding: TemplateBinding | undefined): void {
  if (!binding) {
    return;
  }
  tab.templateId = binding.templateId;
  tab.templateValues = binding.values;
  tab.templateStateVersion = binding.stateVersion;
  tab.templateCompatible = binding.compatible;
  if (binding.reason) {
    tab.templateIncompatibleReason = binding.reason;
  }
}

function boundHtmlError(tab: Tab, label: string): string {
  return `This page (${tab.key}) is bound to template "${label}". Edit the template with template_upsert instead of changing this page's HTML.`;
}

function uniqueKey(
  store: BoardStore,
  requested: string | undefined,
  title: string,
  id: string,
  reserved: Set<string> = new Set()
): string {
  const taken = (key: string) => Boolean(store.get(key)) || reserved.has(key);
  const claim = (key: string) => {
    store.releaseTrashedKey(key);
    return key;
  };
  if (requested) {
    const key = pageKey(requested);
    if (key && !taken(key)) {
      return claim(key);
    }
    if (key) {
      return claim(`${key}-${id.slice(2)}`);
    }
  }
  const base = pageKey(title) || `${PAGE_KEY_PREFIX}page`;
  if (!taken(base)) {
    return claim(base);
  }
  return claim(`${base}-${id.slice(2)}`);
}

function shouldClose(destination: ImportDestination, closedAt?: number): boolean {
  switch (destination) {
    case "closed":
      return true;
    case "meta":
      return typeof closedAt === "number";
    default: {
      const _never: never = destination;
      return _never;
    }
  }
}

function actorNotice(activate: boolean, structural: boolean, actor?: PageActor): UpsertNotice {
  return { activate, structural, ...(actor?.thread ? { thread: actor.thread } : {}) };
}

/** The date a page is judged by; undefined when it has none (an open page has no close date). */
function cleanupDate(tab: Tab, basis: CleanupBasis): number | undefined {
  switch (basis) {
    case "edited":
      return Math.max(tab.updatedAt, tab.stateUpdatedAt);
    case "created":
      return tab.createdAt;
    case "closed":
      return tab.closedAt;
    default:
      return Math.max(tab.updatedAt, tab.stateUpdatedAt, tab.closedAt ?? 0);
  }
}

function finiteTs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const store = new BoardStore();
