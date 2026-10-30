import type { Browser, BrowserContext, CDPSession, Frame, Locator, Page } from "playwright-core";
import { BROWSER_ACTIONS, type BrowserAction } from "./browserActions.js";
import { launchChromium } from "./chromium.js";
import { PORT, gatewayHost } from "./config.js";
import { embedUrlFromHtml } from "./embed.js";
import { log } from "./log.js";
import { pngOrJpeg, screenshotUrl, shotOptions } from "./screenshot.js";
import { store } from "./store.js";

/**
 * The agent browser: a headless Chromium that Scribe chat threads drive through the browser_*
 * MCP tools, so it never takes the user's focus. The chat shows it live (watchBrowser) and the
 * user can click and type into it (browserInput). Each thread gets its own context (cookies and
 * storage stay apart, and survive between turns) with its own tabs. A context closes when its thread is archived or
 * deleted, or after it sits idle; the browser closes with its last context. It is a separate
 * browser from the headless one behind page_screenshot, so a stuck agent page can't break that.
 * SCRIBE_AGENT_BROWSER_HEADED=1 shows it as a desktop window instead (debugging).
 */

const LAUNCH_ARGS = ["--mute-audio", "--no-first-run", "--no-default-browser-check"];
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_VIEWPORT = 320;
const MAX_VIEWPORT = 2560;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 8_000;
const SETTLE_MS = 2_000;
/** Playwright dragTo defaults to 1 (one jump). Pointer-event UIs need travel first. */
const DEFAULT_DRAG_STEPS = 10;
const MAX_DRAG_STEPS = 50;
const IDLE_CLOSE_MS = 30 * 60_000;
const MAX_LOG = 500;
const DEFAULT_SNAPSHOT_CHARS = 20_000;
const MAX_SNAPSHOT_CHARS = 100_000;
const MAX_EVAL_CHARS = 20_000;
const MAX_LIST = 200;
const FRAME_QUALITY = 70;
const FRAME_MAX = 1920;

type ConsoleEntry = { seq: number; at: number; level: string; text: string; location?: string };
type NetworkEntry = {
  seq: number;
  at: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  failure?: string;
  ms?: number;
};

type BrowserTab = {
  id: string;
  page: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
};

export type BrowserControl = "free" | "agent" | "user";
export type Activity = { kind: "text"; field: string; count: number; password?: boolean } | { kind: "event"; text: string };

type Session = {
  control: BrowserControl;
  controlSince: number;
  agentAt: number;
  userActivity: Activity[];
  userOrigins: Set<string>;
  handoff: { message: string } | null;
  fit: boolean;
  viewport: { width: number; height: number };
  reportedControl?: BrowserControl;
  threadId: string;
  context: BrowserContext;
  tabs: Map<string, BrowserTab>;
  current?: string;
  nextTab: number;
  seq: number;
  idle: ReturnType<typeof setTimeout> | null;
};

export type Target = { ref?: string; selector?: string; text?: string };

/** A thread's tabs, for the chat's browser button and live view. */
export type BrowserView = {
  control: BrowserControl;
  controlSince: number;
  agentAt: number;
  handoff: { message: string } | null;
  viewport: { width: number; height: number };
  fit: boolean;
  key?: string;
  threadId: string;
  tabs: Array<{ tab: string; url: string; title: string; current: boolean }>;
};

/** One screencast frame: a JPEG of the tab's viewport, which is width × height CSS pixels. */
export type BrowserFrame = { tab: string; data: string; width: number; height: number };

export type BrowserInput = {
  tab?: string;
  kind: "click" | "down" | "up" | "move" | "wheel" | "key" | "text";
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  dx?: number;
  dy?: number;
  /** A Playwright key, e.g. Enter or Control+A. */
  key?: string;
  text?: string;
};

type Watcher = {
  threadId: string;
  onFrame: (frame: BrowserFrame) => void;
  onView: (view: BrowserView | null) => void;
  tab?: BrowserTab;
  cdp?: CDPSession;
  closed: boolean;
  maxWidth?: number;
  everyNthFrame?: number;
};

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<Session>>();
const changeListeners = new Set<(view: BrowserView | null, threadId: string) => void>();
const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
const watchers = new Set<Watcher>();

/**
 * Hosts the agent browser may load as a page: loopback only (dev servers and Scribe itself).
 * Subresources and iframes are not checked, so a local page can still pull in its CDN fonts.
 */
export function allowedBrowserUrl(raw: string, userOrigins?: ReadonlySet<string>): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "about:" || url.protocol === "data:") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (userOrigins?.has(url.origin)) return true;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Board routes that open files from disk as pages, or list folders (#655). The board UI calls them
 * for the user; the agent browser sends no agent header, so without this an agent could drive the
 * board UI (or fetch from it) to open and read any file. Agents may link files (file: links), and
 * read a file page once the user has opened it, like any page.
 */
const FILE_OPEN_ROUTES = /^\/api\/(files\/(open|open-folder|upload|list)|temp-pages\/|agent\/(?:threads\/[^/]+\/browser(?:\/|$)|browsers(?:$|\?)))/;

/** A request from the agent browser to this board's file-opening routes. Other loopback servers are left alone. */
export function blockedBoardRequest(raw: string, port: number = PORT): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!allowedBrowserUrl(raw) || url.protocol === "about:" || url.protocol === "data:") {
    return false;
  }
  if (Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== port) return false;
  // Another device's UI through the gateway (#905): agents get no access to other devices.
  return FILE_OPEN_ROUTES.test(url.pathname) || gatewayHost(url.hostname) !== undefined;
}

/** A URL the agent passed, or a Scribe page key or id, as the URL to load. */
export function resolveBrowserUrl(input: { url?: string; key?: string }): string {
  if (input.key) {
    const tab = store.get(input.key);
    if (!tab) {
      throw new Error(`tab not found: ${input.key}`);
    }
    return screenshotUrl(tab);
  }
  const url = input.url?.trim();
  if (!url) {
    throw new Error("Provide url or key");
  }
  // "localhost:5173" and "127.0.0.1:3000/x" are common shorthands.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data):/i.test(url) ? url : `http://${url}`;
}

export function browserHttpStatus(message: string): number {
  if (message === "agent_driving" || message.startsWith("The user is controlling the browser.")) return 409;
  if (
    message.startsWith("tab not found") ||
    message.startsWith("no browser tab") ||
    message.startsWith("frame not found") ||
    message.startsWith("no frame shows")
  ) {
    return 404;
  }
  if (message.includes("Could not launch")) {
    return 503;
  }
  if (/timeout/i.test(message)) {
    return 504;
  }
  if (message.startsWith("internal:")) {
    return 500;
  }
  return 400;
}

export async function browserOpen(
  threadId: string,
  input: { url?: string; key?: string; tab?: string; newTab?: boolean; snapshot?: boolean }
) {
  const url = resolveBrowserUrl(input);
  const session = await ensureSession(threadId);
  agentOperation(session, true);
  if (!allowedBrowserUrl(url, session.userOrigins)) throw new Error(blockedMessage(url));
  const tab = input.newTab || !session.tabs.size ? await newTab(session) : pickTab(session, input.tab);
  session.current = tab.id;
  changed(threadId);
  await tab.page.bringToFront().catch(() => undefined);
  let navError: string | undefined;
  try {
    await tab.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    navError = (err as Error).message.split("\n")[0];
    if (!/timeout/i.test(navError)) {
      throw new Error(`Could not open ${url}: ${navError}`);
    }
  }
  return {
    tab: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    ...(navError ? { warning: `The page did not finish loading: ${navError}` } : {}),
    ...(input.snapshot === false ? {} : await snapshotOf(tab.page, undefined, DEFAULT_SNAPSHOT_CHARS)),
    ...errorsSince(tab, 0),
  };
}

export async function browserSnapshot(
  threadId: string,
  input: { tab?: string; selector?: string; maxChars?: number; frame?: string }
) {
  const session = await requireSession(threadId);
  agentOperation(session, false);
  const tab = pickTab(session, input.tab);
  const maxChars = clamp(input.maxChars ?? DEFAULT_SNAPSHOT_CHARS, 1_000, MAX_SNAPSHOT_CHARS);
  const frame = await frameOf(tab.page, input.frame);
  return {
    tab: tab.id,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    ...(frame ? { frame: frame.url() } : {}),
    ...(await snapshotOf(frame ?? tab.page, input.selector, maxChars)),
  };
}

export async function browserAct(
  threadId: string,
  input: Target & {
    tab?: string;
    action: BrowserAction;
    value?: string | string[];
    keys?: string;
    to?: Target;
    dx?: number;
    dy?: number;
    steps?: number;
    snapshot?: boolean;
    frame?: string;
  }
) {
  const session = await requireSession(threadId);
  agentOperation(session, true);
  const tab = pickTab(session, input.tab);
  const { page } = tab;
  const frame = await frameOf(page, input.frame);
  const locate = (target: Target) => locateIn(page, frame, target);
  const mark = tab.console.at(-1)?.seq ?? 0;
  const value = input.value;
  const text = Array.isArray(value) ? value.join("") : value ?? "";
  switch (input.action) {
    case "click":
      await locate(input).click({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "dblclick":
      await locate(input).dblclick({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "hover":
      await locate(input).hover({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "fill":
      await locate(input).fill(text, { timeout: ACTION_TIMEOUT_MS });
      break;
    case "type":
      if (hasTarget(input)) {
        await locate(input).pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.type(text);
      }
      break;
    case "press": {
      const keys = input.keys || text;
      if (!keys) {
        throw new Error("press needs keys, e.g. Enter or Control+A");
      }
      if (hasTarget(input)) {
        await locate(input).press(keys, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(keys);
      }
      break;
    }
    case "select":
      await locate(input).selectOption(Array.isArray(value) ? value : text, { timeout: ACTION_TIMEOUT_MS });
      break;
    case "check":
      await locate(input).check({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "uncheck":
      await locate(input).uncheck({ timeout: ACTION_TIMEOUT_MS });
      break;
    case "scroll":
      if (hasTarget(input) && input.dx === undefined && input.dy === undefined) {
        await locate(input).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      } else {
        if (hasTarget(input)) {
          await locate(input).hover({ timeout: ACTION_TIMEOUT_MS });
        }
        await page.mouse.wheel(input.dx ?? 0, input.dy ?? 600);
      }
      break;
    case "drag":
      if (!input.to || !hasTarget(input.to)) {
        throw new Error("drag needs to: { ref | selector | text }");
      }
      await locate(input).dragTo(locate(input.to), {
        timeout: ACTION_TIMEOUT_MS,
        steps: clamp(input.steps ?? DEFAULT_DRAG_STEPS, 1, MAX_DRAG_STEPS),
      });
      break;
    case "back":
      await page.goBack({ timeout: NAV_TIMEOUT_MS });
      break;
    case "forward":
      await page.goForward({ timeout: NAV_TIMEOUT_MS });
      break;
    case "reload":
      await page.reload({ timeout: NAV_TIMEOUT_MS });
      break;
    default:
      throw new Error(`unknown action: ${String(input.action)}. Use one of ${BROWSER_ACTIONS.join(", ")}`);
  }
  await settle(page);
  return {
    tab: tab.id,
    action: input.action,
    url: page.url(),
    title: await page.title().catch(() => ""),
    ...errorsSince(tab, mark),
    ...(input.snapshot === false ? {} : await snapshotOf(frame ?? page, undefined, DEFAULT_SNAPSHOT_CHARS)),
  };
}

export async function browserScreenshot(
  threadId: string,
  input: Target & { tab?: string; fullPage?: boolean; frame?: string }
) {
  const session = await requireSession(threadId);
  agentOperation(session, false);
  const tab = pickTab(session, input.tab);
  const { page } = tab;
  const frame = await frameOf(page, input.frame);
  // With a frame and no target, the iframe's own box.
  const target = hasTarget(input) ? locateIn(page, frame, input) : await frame?.frameElement();
  const { buffer, mimeType } = await pngOrJpeg((type) =>
    target
      ? target.screenshot({ ...shotOptions(type), timeout: ACTION_TIMEOUT_MS })
      : page.screenshot({ ...shotOptions(type), fullPage: Boolean(input.fullPage) })
  );
  return {
    tab: tab.id,
    url: page.url(),
    mimeType,
    data: buffer.toString("base64"),
    bytes: buffer.length,
  };
}

export async function browserEval(threadId: string, input: { tab?: string; script: string; frame?: string }) {
  const session = await requireSession(threadId);
  agentOperation(session, true);
  const tab = pickTab(session, input.tab);
  if (!input.script?.trim()) {
    throw new Error("Provide script");
  }
  const frame = (await frameOf(tab.page, input.frame)) ?? tab.page.mainFrame();
  // An expression, or a function body when it uses return.
  const body = /\breturn\b/.test(input.script) ? input.script : `return (${input.script});`;
  const value = await frame.evaluate(
    async (source) => {
      const fn = new Function(`return (async () => { ${source} })();`) as () => Promise<unknown>;
      const result = await fn();
      if (result === undefined) return { undefined: true };
      try {
        return { json: JSON.stringify(result) };
      } catch {
        return { json: JSON.stringify(String(result)) };
      }
    },
    body
  );
  const text = "undefined" in value ? "undefined" : value.json ?? "null";
  return {
    tab: tab.id,
    ...(frame !== tab.page.mainFrame() ? { frame: frame.url() } : {}),
    result: text.length > MAX_EVAL_CHARS ? `${text.slice(0, MAX_EVAL_CHARS)}… (${text.length} chars)` : text,
  };
}

export async function browserConsole(
  threadId: string,
  input: { tab?: string; level?: string; pattern?: string; since?: number; limit?: number; clear?: boolean }
) {
  const session = await requireSession(threadId);
  agentOperation(session, false);
  const tab = pickTab(session, input.tab);
  const pattern = input.pattern ? new RegExp(input.pattern, "i") : null;
  const levels = levelFilter(input.level);
  const rows = tab.console.filter(
    (row) =>
      row.seq > (input.since ?? 0) && (!levels || levels.has(row.level)) && (!pattern || pattern.test(row.text))
  );
  const limit = clamp(input.limit ?? 100, 1, MAX_LIST);
  if (input.clear) {
    tab.console.length = 0;
  }
  return { tab: tab.id, total: rows.length, messages: rows.slice(-limit), cursor: tab.console.at(-1)?.seq ?? input.since ?? 0 };
}

export async function browserNetwork(
  threadId: string,
  input: { tab?: string; urlPattern?: string; failedOnly?: boolean; since?: number; limit?: number; clear?: boolean }
) {
  const session = await requireSession(threadId);
  agentOperation(session, false);
  const tab = pickTab(session, input.tab);
  const pattern = input.urlPattern ? new RegExp(input.urlPattern, "i") : null;
  const rows = tab.network.filter(
    (row) =>
      row.seq > (input.since ?? 0) &&
      (!pattern || pattern.test(row.url)) &&
      (!input.failedOnly || row.failure !== undefined || (row.status ?? 0) >= 400)
  );
  const limit = clamp(input.limit ?? 100, 1, MAX_LIST);
  if (input.clear) {
    tab.network.length = 0;
  }
  return { tab: tab.id, total: rows.length, requests: rows.slice(-limit), cursor: tab.network.at(-1)?.seq ?? input.since ?? 0 };
}

export async function browserViewport(
  threadId: string,
  input: { tab?: string; width?: number; height?: number; colorScheme?: "light" | "dark" | "no-preference" }
) {
  const session = await requireSession(threadId);
  agentOperation(session, true);
  const tab = pickTab(session, input.tab);
  const current = tab.page.viewportSize() ?? DEFAULT_VIEWPORT;
  const size = {
    width: clamp(input.width ?? current.width, MIN_VIEWPORT, MAX_VIEWPORT),
    height: clamp(input.height ?? current.height, MIN_VIEWPORT, MAX_VIEWPORT),
  };
  session.viewport = size;
  changed(threadId);
  await tab.page.setViewportSize(size);
  if (input.colorScheme) {
    await tab.page.emulateMedia({ colorScheme: input.colorScheme });
  }
  return { tab: tab.id, ...size, ...(input.colorScheme ? { colorScheme: input.colorScheme } : {}) };
}

export async function browserTabs(threadId: string, input: { close?: string; select?: string; closeAll?: boolean }) {
  const active = sessions.get(threadId);
  if (active) agentOperation(active, Boolean(input.close || input.select || input.closeAll));
  if (input.closeAll) {
    const metadata = browserAgentResult(threadId);
    await closeThreadBrowser(threadId);
    return { tabs: [], closed: true, ...metadata };
  }
  const session = sessions.get(threadId);
  if (!session) {
    return { tabs: [] };
  }
  touch(session);
  if (input.close) {
    const tab = pickTab(session, input.close);
    await tab.page.close().catch(() => undefined);
    session.tabs.delete(tab.id);
    if (session.control === "user") addActivity(session.userActivity, { kind: "event", text: `Closed tab ${tab.id}` });
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1);
    }
    changed(threadId);
  }
  if (input.select) {
    const tab = pickTab(session, input.select);
    session.current = tab.id;
    changed(threadId);
    await tab.page.bringToFront().catch(() => undefined);
  }
  const tabs = await Promise.all(
    [...session.tabs.values()].map(async (tab) => ({
      tab: tab.id,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      current: tab.id === session.current,
    }))
  );
  return { tabs };
}

/** Closes a thread's context and its window. The browser goes with the last one. */
export async function closeThreadBrowser(threadId: string): Promise<void> {
  const session = sessions.get(threadId);
  if (!session) {
    return;
  }
  sessions.delete(threadId);
  if (session.idle) {
    clearTimeout(session.idle);
  }
  await session.context.close().catch(() => undefined);
  changed(threadId);
  if (!sessions.size) {
    await closeAgentBrowser();
  }
}

export async function closeAgentBrowser(): Promise<void> {
  for (const session of sessions.values()) {
    if (session.idle) {
      clearTimeout(session.idle);
    }
  }
  const closing = [...sessions.keys()];
  sessions.clear();
  closing.forEach(changed);
  const current = browser;
  browser = null;
  launching = null;
  if (current) {
    await current.close().catch(() => undefined);
  }
}

export function browserSessions(): Array<{ threadId: string; tabs: number }> {
  return [...sessions.values()].map((session) => ({ threadId: session.threadId, tabs: session.tabs.size }));
}

/** A thread's tabs, or null when it has no browser open. */
export async function browserView(threadId: string): Promise<BrowserView | null> {
  const session = sessions.get(threadId);
  if (!session || !session.tabs.size) {
    return null;
  }
  const tabs = await Promise.all(
    [...session.tabs.values()].map(async (tab) => ({
      tab: tab.id,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      current: tab.id === session.current,
    }))
  );
  return { threadId, tabs, control: session.control, controlSince: session.controlSince, agentAt: session.agentAt, handoff: session.handoff, viewport: session.viewport, fit: session.fit, ...(store.browserPage(threadId) ? { key: store.browserPage(threadId)!.key } : {}) };
}

export async function browserViews(): Promise<BrowserView[]> {
  const views = await Promise.all([...sessions.keys()].map(browserView));
  return views.filter((view): view is BrowserView => view !== null);
}

/** Calls fn when a thread's browser opens, closes, navigates, or switches tabs. */
export function onBrowserChange(fn: (view: BrowserView | null, threadId: string) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/**
 * Streams a thread's current tab as screencast frames (sent when it paints), following the
 * agent when it switches or opens tabs. Waits for the thread to open a browser if it has none.
 */
export function watchBrowser(
  threadId: string,
  onFrame: (frame: BrowserFrame) => void,
  onView: (view: BrowserView | null) => void,
  opts: { maxWidth?: number; everyNthFrame?: number } = {}
): () => void {
  const watcher: Watcher = { threadId, onFrame, onView, closed: false, ...opts };
  watchers.add(watcher);
  void browserView(threadId).then((view) => !watcher.closed && onView(view));
  void retarget(watcher);
  return () => {
    watcher.closed = true;
    watchers.delete(watcher);
    const session = sessions.get(threadId);
    if (session) touch(session);
    void stopCast(watcher.cdp);
    watcher.cdp = undefined;
  };
}

/** The user's mouse and keys from the chat's live view, at viewport CSS pixels. */
export async function browserInput(threadId: string, input: BrowserInput) {
  const session = await requireSession(threadId);
  userOperation(session);
  const { page } = pickTab(session, input.tab);
  await logInput(session, page, input);
  const x = Number(input.x ?? 0);
  const y = Number(input.y ?? 0);
  const button = input.button === "middle" || input.button === "right" ? input.button : "left";
  const clickCount = clamp(input.clickCount ?? 1, 1, 3);
  switch (input.kind) {
    case "click":
      await page.mouse.click(x, y, { button, clickCount });
      break;
    case "move":
      await page.mouse.move(x, y);
      break;
    case "down":
      await page.mouse.move(x, y);
      await page.mouse.down({ button, clickCount });
      break;
    case "up":
      await page.mouse.move(x, y);
      await page.mouse.up({ button, clickCount });
      break;
    case "wheel":
      await page.mouse.move(x, y);
      await page.mouse.wheel(Number(input.dx ?? 0), Number(input.dy ?? 0));
      break;
    case "key":
      if (!input.key) throw new Error("key input needs key");
      await page.keyboard.press(input.key);
      break;
    case "text":
      if (input.text) await page.keyboard.insertText(input.text);
      break;
    default:
      throw new Error(`unknown input: ${String(input.kind)}`);
  }
  return { ok: true };
}

/** Compact activity records never retain typed values. */
export function addActivity(log: Activity[], entry: Activity): void {
  const last = log.at(-1);
  if (entry.kind === "text" && last?.kind === "text" && entry.field === last.field && !!entry.password === !!last.password) last.count += entry.count;
  else log.push(entry);
  if (log.length > 60) log.splice(0, log.length - 60);
}

export function activitySummary(log: readonly Activity[]): string[] {
  return log.map(entry => entry.kind === "event" ? entry.text : entry.password ? "Typed into a password field" : `Typed ${entry.count} characters into ${entry.field}`);
}

type ControlState = { control: BrowserControl; controlSince: number; userActivity: Activity[] };
export function setBrowserControl(state: ControlState, control: BrowserControl): void {
  if (state.control !== control) { state.control = control; state.controlSince = Date.now(); }
}
export function agentControlRule(state: ControlState, mutating: boolean): void {
  if (!mutating) return;
  if (state.control === "user") throw new Error('The user is controlling the browser. Read-only tools (browser_snapshot, browser_screenshot, browser_console, browser_network) still work. To act, call browser_control with action "take", or "handoff" to wait until they hand it back.' + (state.userActivity.length ? "\n" + activitySummary(state.userActivity).join("\n") : ""));
  setBrowserControl(state, "agent");
}
export function userControlRule(state: ControlState): void {
  if (state.control === "agent") throw new Error("agent_driving");
  setBrowserControl(state, "user");
}
export function releaseAgentControl(state: ControlState): void {
  if (state.control === "agent") setBrowserControl(state, "free");
}
function agentOperation(session: Session, mutating: boolean): void {
  agentControlRule(session, mutating);
  session.agentAt = Date.now();
  changed(session.threadId);
}
function userOperation(session: Session): void {
  userControlRule(session);
  changed(session.threadId);
}
/** Added to every MCP result, consuming only activity delivered to the agent. */
export function browserAgentResult(threadId: string): { userActivity?: string[]; control?: BrowserControl } {
  const session = sessions.get(threadId);
  if (!session) return {};
  const result = { ...(session.userActivity.length ? { userActivity: activitySummary(session.userActivity) } : {}), ...(session.reportedControl !== session.control ? { control: session.control } : {}) };
  session.userActivity.length = 0;
  session.reportedControl = session.control;
  return result;
}
export function browserTurnEnded(threadId: string): void {
  const session = sessions.get(threadId);
  if (session) { releaseAgentControl(session); changed(threadId); }
}
export function browserUserMessage(threadId: string): void {
  const session = sessions.get(threadId);
  if (session?.control === "user") { setBrowserControl(session, "free"); session.handoff = null; changed(threadId); }
}
export async function ensureBrowserView(threadId: string): Promise<void> {
  const session = await ensureSession(threadId);
  if (!session.tabs.size) { const tab = await newTab(session); session.current = tab.id; }
  changed(threadId);
}
export async function browserControl(threadId: string, control: BrowserControl, message?: string): Promise<void> {
  await ensureBrowserView(threadId);
  const session = await requireSession(threadId);
  setBrowserControl(session, control);
  session.handoff = message ? { message } : null;
  if (control === "agent") session.agentAt = Date.now();
  changed(threadId);
}
export async function browserHandoffResult(threadId: string) {
  const session = await requireSession(threadId);
  setBrowserControl(session, "agent");
  session.handoff = null;
  session.agentAt = Date.now();
  const tab = pickTab(session);
  changed(threadId);
  return { control: "agent", userActivity: [] as string[], url: tab.page.url(), title: await tab.page.title().catch(() => ""), ...await snapshotOf(tab.page, undefined, DEFAULT_SNAPSHOT_CHARS), ...browserAgentResult(threadId) };
}
export function browserActivity(threadId: string): string[] {
  return activitySummary(sessions.get(threadId)?.userActivity ?? []);
}
export async function browserNavigate(threadId: string, input: { tab?: string; url?: string; action?: "back" | "forward" | "reload" }) {
  const session = await requireSession(threadId);
  // Address-bar URLs are user grants; reject invalid schemes before changing the control.
  const url = input.url === undefined ? undefined : resolveBrowserUrl({ url: input.url });
  if (url && !/^https?:/.test(url)) throw new Error("Navigation needs an http(s) URL");
  if (!url && !["back", "forward", "reload"].includes(input.action ?? "")) throw new Error("Provide url or action");
  userOperation(session);
  const tab = pickTab(session, input.tab);
  session.current = tab.id;
  if (url) {
    session.userOrigins.add(new URL(url).origin);
    addActivity(session.userActivity, { kind: "event", text: `Opened ${url}` });
    await tab.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
  } else if (input.action === "back") await tab.page.goBack({ timeout: NAV_TIMEOUT_MS });
  else if (input.action === "forward") await tab.page.goForward({ timeout: NAV_TIMEOUT_MS });
  else await tab.page.reload({ timeout: NAV_TIMEOUT_MS });
  changed(threadId);
  return { ok: true };
}
export async function browserUserTabs(threadId: string, input: { select?: string; close?: string; newTab?: boolean }) {
  const session = await requireSession(threadId);
  userOperation(session);
  if (input.newTab) session.current = (await newTab(session)).id;
  if (input.select) {
    const tab = pickTab(session, input.select);
    session.current = tab.id;
    await tab.page.bringToFront();
    addActivity(session.userActivity, { kind: "event", text: `Selected tab ${tab.id}` });
  }
  if (input.close) await pickTab(session, input.close).page.close();
  changed(threadId);
  return { ok: true };
}
export async function browserFit(threadId: string, input: { width?: number; height?: number; fit?: false }) {
  const session = await requireSession(threadId);
  session.fit = input.fit !== false;
  session.viewport = session.fit ? { width: clamp(Number(input.width), MIN_VIEWPORT, MAX_VIEWPORT), height: clamp(Number(input.height), MIN_VIEWPORT, MAX_VIEWPORT) } : { ...DEFAULT_VIEWPORT };
  await Promise.all([...session.tabs.values()].map(tab => tab.page.setViewportSize(session.viewport)));
  changed(threadId);
  return { ok: true };
}

async function logInput(session: Session, page: Page, input: BrowserInput): Promise<void> {
  if (input.kind === "click" || input.kind === "down") {
    const target = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { role: "element", name: "" };
      return { role: el.getAttribute("role") || el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60) };
    }, { x: Number(input.x ?? 0), y: Number(input.y ?? 0) }).catch(() => ({ role: "element", name: "" }));
    addActivity(session.userActivity, { kind: "event", text: `Clicked ${target.role} "${target.name}"` });
  } else if (input.kind === "text" || (input.kind === "key" && input.key?.length === 1)) {
    const field = await page.evaluate(() => {
      const el = document.activeElement;
      return { password: el?.getAttribute("type") === "password", name: (el?.getAttribute("aria-label") || el?.getAttribute("name") || el?.id || "field").slice(0, 60) };
    }).catch(() => ({ password: false, name: "field" }));
    addActivity(session.userActivity, { kind: "text", field: field.name, password: field.password, count: input.kind === "text" ? [...(input.text ?? "")].length : 1 });
  }
}

function blockedMessage(url: string): string {
  return `The agent browser only opens loopback addresses (localhost, 127.x.x.x, *.localhost) and Scribe pages; ${url} is not one.`;
}

async function requireSession(threadId: string): Promise<Session> {
  const session = sessions.get(threadId);
  if (!session) {
    throw new Error("no browser tab is open for this thread: call browser_open first");
  }
  touch(session);
  return session;
}

async function ensureSession(threadId: string): Promise<Session> {
  const existing = sessions.get(threadId);
  if (existing && browser?.isConnected()) {
    touch(existing);
    return existing;
  }
  sessions.delete(threadId);
  let pending = opening.get(threadId);
  if (!pending) {
    pending = createSession(threadId).finally(() => opening.delete(threadId));
    opening.set(threadId, pending);
  }
  return pending;
}

async function createSession(threadId: string): Promise<Session> {
  const opened = await ensureBrowser();
  const context = await opened.newContext({ viewport: DEFAULT_VIEWPORT, serviceWorkers: "block" });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const session: Session = { threadId, context, tabs: new Map(), nextTab: 1, seq: 0, idle: null, control: "free", controlSince: Date.now(), agentAt: 0, userActivity: [], userOrigins: new Set(), handoff: null, fit: false, viewport: { ...DEFAULT_VIEWPORT } };
  // Top-level navigations stay on loopback, including links and redirects the page follows. No request
  // may reach the board's file-opening routes (blockedBoardRequest).
  await context.route("**/*", (route) => {
    const request = route.request();
    const top = request.isNavigationRequest() && !request.frame().parentFrame();
    const userNavigation = top && session.control === "user" && /^https?:/.test(request.url());
    if (userNavigation) session.userOrigins.add(new URL(request.url()).origin);
    if (blockedBoardRequest(request.url()) || (top && !userNavigation && !allowedBrowserUrl(request.url(), session.userOrigins))) {
      void route.abort("blockedbyclient");
      return;
    }
    void route.fallback();
  });
  context.on("page", (page) => {
    if (![...session.tabs.values()].some((tab) => tab.page === page)) {
      // A popup or target=_blank link: track it like a tab the agent opened.
      const tab = track(session, page);
      session.current = tab.id;
      changed(threadId);
    }
  });
  context.on("close", () => {
    if (sessions.get(threadId) === session) {
      sessions.delete(threadId);
    }
  });
  sessions.set(threadId, session);
  touch(session);
  changed(threadId);
  return session;
}

async function newTab(session: Session): Promise<BrowserTab> {
  const page = await session.context.newPage();
  await page.setViewportSize(session.viewport);
  return [...session.tabs.values()].find((tab) => tab.page === page) ?? track(session, page);
}

function track(session: Session, page: Page): BrowserTab {
  const tab: BrowserTab = { id: `b${session.nextTab++}`, page, console: [], network: [] };
  session.tabs.set(tab.id, tab);
  if (session.control === "user") addActivity(session.userActivity, { kind: "event", text: `Opened tab ${tab.id}` });
  const push = <T>(list: T[], row: T) => {
    list.push(row);
    if (list.length > MAX_LOG) {
      list.splice(0, list.length - MAX_LOG);
    }
  };
  page.on("console", (msg) => {
    const loc = msg.location();
    push(tab.console, {
      seq: ++session.seq,
      at: Date.now(),
      level: msg.type(),
      text: msg.text(),
      ...(loc?.url ? { location: `${loc.url}:${loc.lineNumber + 1}` } : {}),
    });
  });
  page.on("pageerror", (err) => {
    push(tab.console, { seq: ++session.seq, at: Date.now(), level: "pageerror", text: err.stack || err.message });
  });
  const started = new Map<object, NetworkEntry>();
  page.on("request", (request) => {
    const row: NetworkEntry = {
      seq: ++session.seq,
      at: Date.now(),
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
    };
    started.set(request, row);
    push(tab.network, row);
  });
  page.on("requestfinished", (request) => {
    const row = started.get(request);
    started.delete(request);
    if (!row) return;
    row.ms = Date.now() - row.at;
    void request
      .response()
      .then((response) => {
        if (response) row.status = response.status();
      })
      .catch(() => undefined);
  });
  page.on("requestfailed", (request) => {
    const row = started.get(request);
    started.delete(request);
    if (!row) return;
    row.ms = Date.now() - row.at;
    row.failure = request.failure()?.errorText ?? "failed";
  });
  page.on("framenavigated", (frame) => {
    if (!frame.parentFrame()) {
      if (session.control === "user" && /^https?:/.test(frame.url())) addActivity(session.userActivity, { kind: "event", text: `Navigated to ${frame.url()}` });
      changed(session.threadId);
    }
  });
  page.on("load", () => changed(session.threadId));
  page.on("close", () => {
    session.tabs.delete(tab.id);
    if (session.control === "user") addActivity(session.userActivity, { kind: "event", text: `Closed tab ${tab.id}` });
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1);
    }
    changed(session.threadId);
  });
  return tab;
}

function pickTab(session: Session, id?: string): BrowserTab {
  const which = id ?? session.current;
  const tab = which ? session.tabs.get(which) : undefined;
  if (!tab) {
    throw new Error(
      id
        ? `no browser tab ${id}; open tabs: ${[...session.tabs.keys()].join(", ") || "none"}`
        : "no browser tab is open for this thread: call browser_open first"
    );
  }
  return tab;
}

function hasTarget(target: Target): boolean {
  return Boolean(target.ref || target.selector || target.text);
}

/**
 * An element by ref, selector, or text. Refs come from the whole tab's snapshot (frames included,
 * e.g. f1e2), so they resolve on the page; selector and text look inside frame when one is given.
 */
function locateIn(page: Page, frame: Frame | null, target: Target): Locator {
  if (target.ref) {
    return page.locator(`aria-ref=${target.ref.replace(/^ref=/, "")}`);
  }
  const root = frame ?? page;
  if (target.selector) {
    return root.locator(target.selector).first();
  }
  if (target.text) {
    return root.getByText(target.text).first();
  }
  throw new Error("Provide ref (from browser_snapshot), selector, or text");
}

/** The frame a browser tool's frame option names, or null for the top page. */
async function frameOf(page: Page, which: string | undefined): Promise<Frame | null> {
  return which?.trim() ? findFrame(page, which.trim()) : null;
}

/**
 * A frame inside the tab, so browser_eval reaches a Scribe page shown in the shell (its iframe is
 * on the content origin, out of reach of the shell's own scripts). which is a Scribe page key or
 * id (the frame that loads its /view/<id>, the visible one first), or a CSS selector of an iframe.
 */
async function findFrame(page: Page, which: string): Promise<Frame> {
  const scribeTab = store.get(which);
  if (scribeTab) {
    const viewPath = `/view/${encodeURIComponent(scribeTab.id)}`;
    const embedUrl = embedUrlFromHtml(scribeTab.html);
    const matches = page.frames().filter((frame) => {
      if (frame === page.mainFrame()) return false;
      const url = frame.url();
      if (embedUrl && url === embedUrl) return true;
      try {
        return new URL(url).pathname === viewPath;
      } catch {
        return false;
      }
    });
    for (const frame of matches) {
      const element = await frame.frameElement().catch(() => null);
      if (element && (await element.isVisible().catch(() => false))) {
        return frame;
      }
    }
    if (matches[0]) {
      return matches[0];
    }
    throw new Error(`no frame shows ${scribeTab.key} in this browser tab; open it in the Scribe shell first`);
  }
  // No auto-wait: a selector that matches nothing fails now, not after the action timeout.
  const element = await page.$(which).catch(() => null);
  const frame = await element?.contentFrame();
  if (!frame) {
    throw new Error(`frame not found: ${which} is not a Scribe page key or id, nor an iframe on this tab`);
  }
  return frame;
}

async function snapshotOf(page: Page | Frame, selector: string | undefined, maxChars: number) {
  try {
    const root = selector ? page.locator(selector).first() : "ariaSnapshot" in page ? page : page.locator(":root");
    const text = await root.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
    return text.length > maxChars
      ? { snapshot: text.slice(0, maxChars), truncated: `snapshot cut at ${maxChars} of ${text.length} chars; pass selector or maxChars` }
      : { snapshot: text };
  } catch (err) {
    return { snapshotError: (err as Error).message.split("\n")[0] };
  }
}

/** Console errors and page errors since a console seq, so a broken click shows up in its own result. */
function errorsSince(tab: BrowserTab, seq: number) {
  const errors = tab.console
    .filter((row) => row.seq > seq && (row.level === "error" || row.level === "pageerror"))
    .slice(-10)
    .map((row) => row.text.split("\n")[0]);
  return errors.length ? { consoleErrors: errors } : {};
}

function levelFilter(level: string | undefined): Set<string> | null {
  if (!level || level === "all") return null;
  if (level === "error") return new Set(["error", "pageerror"]);
  if (level === "warning") return new Set(["error", "pageerror", "warning"]);
  return new Set(level.split(",").map((part) => part.trim()));
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: SETTLE_MS }).catch(() => undefined);
  await page.waitForTimeout(150);
}

function touch(session: Session): void {
  if (session.idle) {
    clearTimeout(session.idle);
  }
  session.idle = setTimeout(() => {
    if ([...watchers].some(w => w.threadId === session.threadId && !w.closed)) { touch(session); return; }
    log(`Closing the idle agent browser of ${session.threadId}`);
    void closeThreadBrowser(session.threadId);
  }, IDLE_CLOSE_MS);
  session.idle.unref?.();
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }
  if (!launching) {
    launching = launchChromium({ headless: process.env.SCRIBE_AGENT_BROWSER_HEADED !== "1", args: LAUNCH_ARGS, purpose: "Agent" })
      .then((opened) => {
        browser = opened;
        opened.on("disconnected", () => {
          if (browser === opened) {
            browser = null;
            for (const session of sessions.values()) {
              if (session.idle) clearTimeout(session.idle);
            }
            const closing = [...sessions.keys()];
            sessions.clear();
            closing.forEach(changed);
          }
        });
        return opened;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

/** Batches a thread's browser changes into one view for listeners, and moves its watchers along. */
function changed(threadId: string): void {
  if (pendingChanges.has(threadId)) {
    return;
  }
  const timer = setTimeout(() => {
    pendingChanges.delete(threadId);
    void browserView(threadId).then((view) => {
      for (const fn of changeListeners) {
        try {
          fn(view, threadId);
        } catch (err) {
          log(`Agent browser change listener failed: ${(err as Error).message}`);
        }
      }
      for (const watcher of watchers) {
        if (watcher.threadId !== threadId) continue;
        watcher.onView(view);
        void retarget(watcher);
      }
    });
  }, 50);
  timer.unref?.();
  pendingChanges.set(threadId, timer);
}

/** Points a watcher's screencast at its thread's current tab. */
async function retarget(watcher: Watcher): Promise<void> {
  const session = sessions.get(watcher.threadId);
  const tab = session?.current ? session.tabs.get(session.current) : undefined;
  if (watcher.closed || tab === watcher.tab) {
    return;
  }
  const old = watcher.cdp;
  watcher.cdp = undefined;
  watcher.tab = tab;
  await stopCast(old);
  if (!tab || !session) {
    return;
  }
  try {
    const cdp = await session.context.newCDPSession(tab.page);
    if (watcher.closed || watcher.tab !== tab) {
      await cdp.detach().catch(() => undefined);
      return;
    }
    watcher.cdp = cdp;
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      if (watcher.closed || watcher.tab !== tab) return;
      watcher.onFrame({
        tab: tab.id,
        data: event.data,
        width: Math.round(event.metadata.deviceWidth),
        height: Math.round(event.metadata.deviceHeight),
      });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: FRAME_QUALITY, maxWidth: clamp(watcher.maxWidth ?? FRAME_MAX, 160, FRAME_MAX), maxHeight: FRAME_MAX, everyNthFrame: clamp(watcher.everyNthFrame ?? 1, 1, 60) });
    // A still page paints nothing new: send what it shows now.
    const size = tab.page.viewportSize() ?? DEFAULT_VIEWPORT;
    // The viewport as it is now (a clip would be relative to the document, so a scrolled page would show its top).
    const shot = (await tab.page.screenshot({ type: "jpeg", quality: FRAME_QUALITY, timeout: ACTION_TIMEOUT_MS })).toString("base64");
    if (!watcher.closed && watcher.tab === tab) {
      watcher.onFrame({ tab: tab.id, data: shot, ...size });
    }
  } catch (err) {
    // The next change tries again.
    if (watcher.tab === tab) watcher.tab = undefined;
    log(`Agent browser live view of ${watcher.threadId}: ${(err as Error).message.split("\n")[0]}`);
  }
}

async function stopCast(cdp: CDPSession | undefined): Promise<void> {
  if (cdp) {
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
