import type { SearchDeclaration } from "./search/chunker.js";
import type { SpacesView } from "./spaces.js";
import { embedUrlFromHtml } from "./embed.js";
import type { SkippedOp, StateOp } from "./stateOps.js";
import type { PageAssetFile, PageAssetMeta, PageAssetUsage } from "./pageAssets.js";
import type { AgentEvent } from "./agent/types.js";
import { declaredPlugins } from "./plugins/manifest.js";

export type BoardState = Record<string, unknown>;

/** One entry in a page's event log: a signal from the page, or a note from Scribe itself. */
export type PageEvent = {
  /** Per-page sequence number, starting at 1. Waits resume after a seq. */
  seq: number;
  name: string;
  /** Small JSON payload, e.g. { card: "c_12" }. */
  data?: unknown;
  at: number;
  /** "user" for page code (the user clicked something), "agent" for an agent, "scribe" for the daemon. */
  by: "user" | "agent" | "scribe";
};

export type TabAsset = {
  name: string;
  mimeType: string;
  bytes: number;
};

export type PreparedAsset = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type TemplateFieldType = "text" | "textarea" | "number" | "select" | "checkbox";

export type TemplateFieldOption = {
  value: string;
  label: string;
};

export type TemplateField = {
  key: string;
  label: string;
  type: TemplateFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: TemplateFieldOption[];
  min?: number;
  max?: number;
  /** Character limit for text and textarea values; defaults to 500 and 4000. */
  maxLength?: number;
};

export type TemplateValues = Record<string, string | number | boolean>;

export type Template = {
  id: string;
  key: string;
  title: string;
  description: string;
  html: string;
  fields: TemplateField[];
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  /** Set on a local copy of a built-in template. */
  source?: TemplateSource;
  /** Markdown for agents working with pages made from this template: state shape, signals, conventions. */
  guide?: string;
  /** Agent prompts the user can run on a page made from this template (page menu, palette, chat slash menu). */
  agentActions?: AgentAction[];
  search?: SearchDeclaration;
  /** False for a page-like template (a note): its pages open unpinned. Unset, the pages open pinned. */
  pin?: false;
};

export const AGENT_ACTION_PLACES = ["menu", "palette", "slash"] as const;
export type AgentActionPlace = (typeof AGENT_ACTION_PLACES)[number];

/**
 * One template-declared agent action. The prompt's placeholders are filled in when it runs:
 * {{selection}} (text selected on the page), {{input}} (text after the slash command),
 * {{page.title}}, {{page.key}}, and the names in `context`; {{#name}}…{{/name}} keeps its text only when
 * name is not empty.
 */
export type AgentAction = {
  /** Slash command name, unique in the template. */
  id: string;
  label: string;
  description?: string;
  prompt: string;
  /** Where it is offered; all three when the template leaves it out. */
  where: AgentActionPlace[];
  /** required: only offered with text selected; none: only without. Default: either. */
  selection?: "required" | "none";
  /**
   * Placeholders the page supplies for what the user right-clicked, e.g. ["card"] for {{card}}: from the
   * data-scribe-context attributes under the cursor, or from scribe.agent.runAction. The action is
   * offered only where the page supplies all of them, so only in a right-click menu.
   */
  context?: string[];
  /** new (default): a new thread on the page with the thread settings; chat: sent in the chat at hand. */
  run?: "new" | "chat";
  /** Settings for a new thread; unset ones follow the user's defaults. */
  thread?: AgentActionThread;
};

export type AgentActionThread = {
  /** Only the reading rungs (#719): board (also "ask", the older name) or readonly. */
  mode?: "board" | "ask" | "readonly";
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  web?: "on" | "limited" | "off";
  /** Thread title; placeholders work here too. */
  title?: string;
};

/** Which built-in a local template was copied from, and that built-in's fingerprint at copy time. */
export type TemplateSource = {
  builtin: string;
  fingerprint: string;
};

export type TemplateMeta = Omit<Template, "html" | "initialState" | "source" | "guide" | "agentActions"> & {
  /** Plugin supplying this template, including its local copies. */
  plugin?: { id: string; name: string };
  /** Its agent actions, or for a local copy of a built-in without its own, the built-in's. */
  agentActions?: AgentAction[];
  htmlBytes: number;
  /** The template carries an agent guide (tool results deliver it). */
  hasGuide?: boolean;
  /** False when pages from this template open unpinned. */
  pin?: false;
  instanceCount: number;
  /** Key of the built-in this template was copied from. */
  builtinSource?: string;
  /** The built-in changed since this copy was made, and the copy could not be updated automatically. */
  builtinUpdate?: boolean;
};

/** A read-only template shipped with the app. Opening one opens its local copy, creating it first if needed. */
export type BuiltinTemplateMeta = Omit<TemplateMeta, "instanceCount" | "builtinSource" | "builtinUpdate"> & {
  builtIn: true;
  /** Id of the local copy, when there is one. */
  localId?: string;
};

export type TemplateBinding = {
  tabId: string;
  templateId: string;
  values: TemplateValues;
  stateVersion: number;
  compatible: boolean;
  reason?: string;
};

export type Folder = {
  id: string;
  description?: string;
  instructions?: string;
  /** null is the Library root. */
  parentId: string | null;
  name: string;
  /** Order among sibling folders; sparse, compare only. */
  pos: number;
  createdAt: number;
  updatedAt: number;
  /** Agent access level and grants (#269); see pageAccess.ts. Omitted when open with no grants. */
  access?: FolderAccess;
  /**
   * The disk folder this Library folder stands for (#707), absolute. Its subfolders without one
   * inherit `<parent's location>\<name>`; see store.folderDiskPath.
   */
  disk?: string;
};

/** A page or folder, as an access grant's target or a page's origin. */
export type AccessTarget = { kind: "page" | "folder"; id: string };

/** A grant on a page or folder. read: only for reading, and only Normal or Open pages (#818). */
export type AccessGrant = AccessTarget & { read?: true };

/**
 * How agents reach pages (#269). public ("Open" in the UI, #723): every chat, whatever its scope;
 * open ("Normal", the default): chats in scope, plus grants; ask: only a grant for the chat itself
 * (every chat asks); trusted: trusted model sources only; restricted: only a chat on that exact page.
 * A user's @mention gets past all of them. The strictest level set up the folder tree wins; with none
 * set, a page is open.
 */
export type AccessLevel = "public" | "open" | "ask" | "trusted" | "restricted";

/**
 * A folder's access level and the pages and folders chats on it may reach without asking. open is
 * kept only under a public folder, where it makes this folder Normal again.
 */
export type FolderAccess = {
  level?: AccessLevel;
  grants?: AccessGrant[];
};

/**
 * A page's access settings beside agentHidden (which stays its Restricted flag): its level, where
 * it came from, and what chats on it may reach without asking.
 */
export type PageAccess = {
  /** open is kept only under a public folder, where it makes this page Normal again. */
  level?: "public" | "open" | "ask" | "trusted";
  /** The page or folder of the chat that created it; set once. Chats there reach it like their own. */
  origin?: AccessTarget;
  grants?: AccessGrant[];
};

export type Tab = {
  id: string;
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  /** Last content change: HTML, title, or template values. Not pins, signals, opening, or moving. */
  updatedAt: number;
  /** Set while the page has no tab in the strip; omitted when open. */
  closedAt?: number;
  /** Library folder; omitted for the root. */
  folderId?: string;
  /** Order among sibling pages in the folder; sparse, compare only. */
  libPos: number;
  /** When the user last renamed the page; agent titles are ignored for USER_TITLE_HOLD_MS after. */
  userTitleAt?: number;
  /** Strip coordinate. Owned by the tab; omitted from agent-facing meta. */
  stripSeq: number;
  revision: number;
  state: BoardState;
  stateRevision: number;
  stateUpdatedAt: number;
  /** Seq of the newest event ever logged on this page. */
  eventSeq: number;
  /** The newest events, oldest first, at most MAX_PAGE_EVENTS. */
  events: PageEvent[];
  assets: TabAsset[];
  templateId?: string;
  templateValues?: TemplateValues;
  templateStateVersion?: number;
  templateCompatible?: boolean;
  templateIncompatibleReason?: string;
  /**
   * Restricted (#269, was Hide from agent). Only the board UI can set this. Agent requests treat
   * the tab as nonexistent, except from a chat on this page or one the user @mentioned it in.
   */
  agentHidden?: boolean;
  /** Agent access level, origin and grants (#269). Only the board UI changes level and grants. */
  access?: PageAccess;
  /** Which in-app agent created the page and last changed it. Omitted until an agent writes. */
  provenance?: PageProvenance;
  /**
   * Where the page's scribe.reply goes, set by the agent that made it (page_show replyTo). Kept
   * with the page's metadata, not its HTML or state, so the page's own code cannot change it.
   */
  replyTo?: ReplyTarget;
  /**
   * The disk folder new chat threads on this page start in. Taken from the thread that created
   * the page; the user can change or clear it. Omitted for none.
   */
  workspace?: string;
  /**
   * A file page (#654): the file on disk the page shows and saves. Kept with the page's metadata,
   * not its state, so the page's own code cannot point it at another file.
   */
  file?: FileBinding;
  /**
   * A temporary page (#655): opened from a file or website link to have a look. It is not in the
   * Library, can't be pinned, and is gone once its tab (or the peek showing it) closes. Keep in
   * Library (or a move into a folder) makes it a page like any other.
   */
  temp?: boolean;
  /**
   * The space the page was made in (#260): the active space when the user made it, or the space a
   * chat was started in when the chat made it. A Library lens filters on it; it never grants or
   * blocks access. Omitted for pages made before spaces recorded this.
   */
  madeIn?: string;
};

/**
 * The file a file page opens. copy: the bytes were dropped in (a browser gives no path), so they
 * live in Scribe's data folder until Save as writes them somewhere else.
 */
export type FileBinding = {
  path: string;
  copy?: boolean;
  /** Hidden sibling retained while the page is in Scribe Trash. */
  trashed?: string;
};

/**
 * A page's reply target: the page (by id) its scribe.reply goes to, and what on it. The target
 * page's template decides what a reply does (see ActionSet.reply); card is for Kanban boards.
 */
export type ReplyTarget = {
  page: string;
  card?: number;
};

/** An in-app chat thread, or an external MCP client with no thread. */
export type PageActor = {
  /** Scribe chat thread id. Omitted for external MCP clients. */
  thread?: string;
  /** Thread title at write time, so Library still has a label if the thread is gone. */
  title?: string;
  /** The thread's workspace folder at write time. A page it creates takes it; provenance does not keep it. */
  workspace?: string;
  /** The thread's page or folder at write time. A page it creates keeps it as its access origin (#269). */
  origin?: AccessTarget;
  /** The space the thread was started in (#260). A page it creates is made in that space. */
  space?: string;
  at: number;
};

export type PageProvenance = {
  /** Set once, when an agent creates the page. User-created pages leave this unset. */
  created?: PageActor;
  /** Last agent write (HTML, title, template values, or state). */
  changed?: PageActor;
};

export type TabMeta = Omit<Tab, "html" | "state" | "events" | "eventSeq" | "stripSeq"> & {
  plugins?: string[];
  htmlBytes: number;
  /** Set when the page asks to be shown as a direct iframe of this URL. */
  embedUrl?: string;
  /** A new page with nothing on it yet; the board shows its New page screen instead of a frame. */
  blank?: boolean;
  /** Not a page yet: a New page that no thread or template has made real. See BoardStore.createDraft. */
  draft?: boolean;
};

export const NEW_PAGE_TITLE = "New page";

/**
 * A page made with New page that has no content yet. Every other way to make a page needs HTML,
 * so empty HTML without a template only happens here.
 */
export function isBlankPage(tab: { html: string; templateId?: string }): boolean {
  return tab.html === "" && !tab.templateId;
}

/** One delete operation. A folder delete is one batch however many pages it held. */
export type DeletedBatch = {
  id: string;
  deletedAt: number;
  tabs: Tab[];
  folders: Folder[];
};

/** Deleted pages and folders stay in the Trash this long, then go for good. */
export const TRASH_DAYS = 7;
export const TRASH_TTL_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

/** A delete batch as the Trash lists it. */
export type TrashBatch = {
  id: string;
  deletedAt: number;
  expiresAt: number;
  tabs: TabMeta[];
  folders: Folder[];
};

export const USER_TITLE_HOLD_MS = 24 * 60 * 60 * 1000;

/** Reserved for the in-app help page. Closing it discards the tab instead of archiving. */
export const PAGE_KEY_PREFIX = "scribe:";
export const WELCOME_KEY = "scribe:welcome";

export function normalizeKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cleaned = trimmed.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80);
}

/**
 * Page keys read "scribe:<slug>" so a pasted key is recognizable on its own. Lookups accept
 * the slug with or without the prefix.
 */
export function pageKey(value: string): string {
  const slug = normalizeKey(value.trim().replace(/^(scribe:)+/i, ""));
  return slug ? `${PAGE_KEY_PREFIX}${slug}` : "";
}

/** A page outside the Library that goes when its tab closes: the help page, or a temporary page. */
export function isAppTab(tab: { key: string; temp?: boolean }): boolean {
  return tab.key === WELCOME_KEY || tab.temp === true;
}

/** Who is asking: the board UI (and tab pages), or an agent through the MCP. */
export type Viewer = "user" | "agent";

/** Standing agent context configured on a Library folder. */
export type FolderInstruction = {
  /** Library path, or null for the root. */
  folder: string | null;
  description?: string;
  text: string;
};

export function visibleTo(tab: { agentHidden?: boolean }, viewer: Viewer): boolean {
  switch (viewer) {
    case "user":
      return true;
    case "agent":
      return !tab.agentHidden;
    default: {
      const _never: never = viewer;
      return _never;
    }
  }
}

export type UpsertNotice = {
  activate: boolean;
  /** User imports are already known to the user; keep their initial notification read. */
  markUnread?: boolean;
  /** HTML, title, or an in-archive write; pin-only updates on open tabs are not structural. */
  structural: boolean;
  /** In-app chat that made this write, so a focused page can take that thread with it. */
  thread?: string;
  /** Its template changed: a page on screen keeps running and loads the new HTML once it is hidden. */
  template?: boolean;
};

export type BoardEvent =
  | {
      type: "snapshot";
      version: string;
      tabs: TabMeta[];
      closed: TabMeta[];
      folders: Folder[];
      activeId: string | null;
      templates: TemplateMeta[];
      builtinTemplates: BuiltinTemplateMeta[];
      persistError: string | null;
      spaces: SpacesView;
      /** Sent to every viewer after a space switch replaced the strip. */
      reset?: boolean;
    }
  | { type: "spaces"; spaces: SpacesView }
  | { type: "page_permission"; id: string; perm: string; value: string }
  | { type: "appearance"; settings: Record<string, string>; revision: number }
  | { type: "tab_upserted"; tab: TabMeta; index?: number; structural: boolean; template?: boolean; markUnread?: boolean }
  | { type: "tab_deleted"; id: string }
  | { type: "tab_focused"; id: string | null }
  | { type: "tab_focus_request"; id: string; thread?: string }
  /** A state change as the ops that made it. A viewer at fromRevision applies them; one behind refetches. */
  | { type: "tab_state"; id: string; fromRevision: number; stateRevision: number; ops: StateOp[]; client?: string; writeId?: string }
  | { type: "tab_event"; id: string; event: PageEvent }
  | { type: "folders"; folders: Folder[] }
  | { type: "trash" }
  | { type: "template_upserted"; template: TemplateMeta }
  | { type: "template_deleted"; id: string }
  | { type: "builtin_templates"; templates: BuiltinTemplateMeta[] }
  | { type: "page_asset_warning"; id: string; title: string; usage: PageAssetUsage }
  | { type: "persist_error"; error: string }
  | { type: "persist_ok" }
  | AgentEvent;

export type UpsertInput = {
  /** Suppress the new-page indicator for user-imported files. Only applies to creation. */
  markUnread?: boolean;
  key?: string;
  title: string;
  html: string;
  activate?: boolean;
  pin?: boolean;
  state?: BoardState;
  assets?: PreparedAsset[];
  /** Folder path like "CLIMS/Releases" for a newly created page. Ignored for existing keys. */
  folder?: string;
  /** An agent writing a key owned by a hidden tab gets a new tab instead. */
  viewer?: Viewer;
  /** In-app or external agent that made this write. User writes leave it unset. */
  actor?: PageActor;
  /** Refuse to replace an existing page whose revision is no longer this one. Ignored when the key is new. */
  expectedRevision?: number;
  /** A blank page (the writing thread's own) that a new, focused page fills instead of making another tab. */
  into?: string;
  /** A new page is temporary (Tab.temp). Ignored for existing keys. */
  temp?: boolean;
  /**
   * Whether the writing agent could still reach a page it made in this folder (#260). A new page goes
   * to its space's home folder only then, so a chat never loses sight of what it just made.
   */
  homeFits?: (folderId: string) => boolean;
};

export type StateWriteInput = {
  /** See stateOps.ts. */
  ops: unknown[];
  /** Skip ops that fail instead of refusing the whole write. Pages write this way. */
  lenient?: boolean;
  expectedRevision?: number;
  /** The bridge instance that wrote, so it can recognize its own delta. */
  client?: string;
  writeId?: string;
  resolveIncompatibility?: boolean;
  /** Local files to store as page assets; op values `asset:<name>` become their URLs. */
  assets?: PageAssetFile[];
  /** In-app or external agent that made this write. User writes leave it unset. */
  actor?: PageActor;
  /** The user's own edit through the page (not an agent, a reply or the board's bookkeeping): links it adds can grant access (#269). */
  byUser?: boolean;
};

export type EventInput = {
  name: string;
  data?: unknown;
  by: PageEvent["by"];
  /** State ops applied (leniently) just before the event is logged, so a wait sees them. */
  ops?: unknown[];
  client?: string;
  writeId?: string;
  actor?: PageActor;
};

export type RestorePlacement = "append" | "index";

/** Where imported pages land. `meta` follows each page's closedAt (missing → open). */
export type ImportDestination = "meta" | "closed";

/** A stale expectedRevision resolves to ok:false with the current revision. */
export type StateWriteResult =
  | { ok: true; tab: Tab; fromRevision: number; applied: StateOp[]; skipped: SkippedOp[]; assets?: PageAssetMeta[] }
  | { ok: false; stateRevision: number };

export function toMeta(tab: Tab): TabMeta {
  const embedUrl = embedUrlFromHtml(tab.html);
  const plugins=declaredPlugins(tab.html);
  return {
    id: tab.id,
    key: tab.key,
    title: tab.title,
    pinned: tab.pinned,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    ...(tab.closedAt ? { closedAt: tab.closedAt } : {}),
    ...(tab.folderId ? { folderId: tab.folderId } : {}),
    libPos: tab.libPos,
    ...(tab.userTitleAt ? { userTitleAt: tab.userTitleAt } : {}),
    revision: tab.revision,
    stateRevision: tab.stateRevision,
    stateUpdatedAt: tab.stateUpdatedAt,
    htmlBytes: Buffer.byteLength(tab.html, "utf8"),
    ...(plugins.length?{plugins}:{}),
    assets: tab.assets,
    ...(tab.agentHidden ? { agentHidden: true } : {}),
    ...(tab.access ? { access: tab.access } : {}),
    ...(tab.provenance ? { provenance: tab.provenance } : {}),
    ...(tab.replyTo ? { replyTo: tab.replyTo } : {}),
    ...(tab.workspace ? { workspace: tab.workspace } : {}),
    ...(tab.file ? { file: tab.file } : {}),
    ...(tab.temp ? { temp: true } : {}),
    ...(tab.madeIn ? { madeIn: tab.madeIn } : {}),
    ...(embedUrl ? { embedUrl } : {}),
    ...(isBlankPage(tab) ? { blank: true } : {}),
    ...(tab.templateId
      ? {
          templateId: tab.templateId,
          templateValues: tab.templateValues ?? {},
          templateStateVersion: tab.templateStateVersion ?? 0,
          templateCompatible: tab.templateCompatible !== false,
          ...(tab.templateIncompatibleReason
            ? { templateIncompatibleReason: tab.templateIncompatibleReason }
            : {}),
        }
      : {}),
  };
}

export function toTemplateMeta(
  template: Template,
  instanceCount = 0,
  builtinUpdate = false,
  agentActions = template.agentActions
): TemplateMeta {
  return {
    id: template.id,
    key: template.key,
    title: template.title,
    description: template.description,
    fields: template.fields,
    ...(template.titleTemplate ? { titleTemplate: template.titleTemplate } : {}),
    stateVersion: template.stateVersion,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    htmlBytes: Buffer.byteLength(template.html, "utf8"),
    instanceCount,
    ...(template.source ? { builtinSource: template.source.builtin } : {}),
    ...(builtinUpdate ? { builtinUpdate: true } : {}),
    ...(template.guide ? { hasGuide: true } : {}),
    ...(agentActions?.length ? { agentActions } : {}),
    ...(template.search ? { search: template.search } : {}),
    ...(template.pin === false ? { pin: false } : {}),
  };
}

export function isTemplateBound(tab: { templateId?: string }): boolean {
  return Boolean(tab.templateId);
}

export function isPlainObject(value: unknown): value is BoardState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTOR_THREAD_MAX = 60;
const ACTOR_TITLE_MAX = 120;

export function normalizeActor(value: unknown): PageActor | undefined {
  if (!isPlainObject(value) || typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return undefined;
  }
  const actor: PageActor = { at: value.at };
  if (typeof value.thread === "string" && value.thread.trim()) {
    actor.thread = value.thread.trim().slice(0, ACTOR_THREAD_MAX);
  }
  if (typeof value.title === "string" && value.title.trim()) {
    actor.title = value.title.trim().slice(0, ACTOR_TITLE_MAX);
  }
  return actor;
}

export function normalizeProvenance(value: unknown): PageProvenance | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const created = normalizeActor(value.created);
  const changed = normalizeActor(value.changed);
  if (!created && !changed) {
    return undefined;
  }
  return { ...(created ? { created } : {}), ...(changed ? { changed } : {}) };
}

/** Record an agent write on a page. `created` is only set when this call creates the page. */
export function noteAgentWrite(tab: Tab, actor: PageActor | undefined, created = false): void {
  const stamped = actor ? normalizeActor(actor) : undefined;
  if (!stamped) {
    return;
  }
  const provenance: PageProvenance = { ...(tab.provenance ?? {}), changed: stamped };
  if (created && !provenance.created) {
    provenance.created = stamped;
  }
  tab.provenance = provenance;
  if (created && !tab.workspace && actor?.workspace) {
    tab.workspace = actor.workspace;
  }
  if (created && actor?.origin && !tab.access?.origin) {
    tab.access = { ...(tab.access ?? {}), origin: { kind: actor.origin.kind, id: actor.origin.id } };
  }
}

export function normalizeReplyTo(value: unknown): ReplyTarget | undefined {
  if (!isPlainObject(value) || typeof value.page !== "string" || !value.page.trim()) {
    return undefined;
  }
  const target: ReplyTarget = { page: value.page.trim().slice(0, 200) };
  if (typeof value.card === "number" && Number.isInteger(value.card) && value.card > 0) {
    target.card = value.card;
  }
  return target;
}

export function normalizeFileBinding(value: unknown): FileBinding | undefined {
  if (!isPlainObject(value) || typeof value.path !== "string" || !value.path.trim()) {
    return undefined;
  }
  return { path: value.path, ...(value.copy === true ? { copy: true } : {}),
    ...(typeof value.trashed === "string" && value.trashed.trim() ? { trashed: value.trashed } : {}) };
}
