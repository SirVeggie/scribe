import { randomBytes } from "node:crypto";
import type { Browser, Page } from "playwright-core";
import { launchChromium } from "./chromium.js";
import { allowCaptureFraming } from "./captureFraming.js";
import { MAX_LOCAL_STATE_BYTES, pageViewUrl } from "./config.js";
import { embedUrlFromHtml } from "./embed.js";
import { store } from "./store.js";
import { isPlainObject, type BoardState } from "./types.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_VIEWPORT = 320;
const MAX_VIEWPORT = 1600;
const MAX_FULL_PAGE_HEIGHT = 6000;
const MAX_PNG_BYTES = 1_500_000;
const IDLE_CLOSE_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;
const JPEG_QUALITY = 82;
const CAPTURE_BOOT_TTL_MS = 60_000;
const FRAME_WAIT_MS = 5_000;
const SHOT_ID = /^[a-f0-9]{12}$/;

const captureBoots = new Map<string, { local: BoardState; at: number }>();

const LAUNCH_ARGS = ["--hide-scrollbars", "--mute-audio"];

export type ScreenshotRequest = {
  idOrKey: string;
  selector?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
  /** Seeded into `scribe.local` for this capture only; not saved as a viewer. */
  local?: unknown;
  /** Start from the most recently written viewer local, then overlay `local`. */
  fromViewer?: boolean;
  /** CSS selector to click after load, before capture. */
  click?: string;
};

export type ScreenshotResult = {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
  fullPage: boolean;
  selector?: string;
  click?: string;
  fromViewer?: boolean;
  local?: boolean;
  embed?: boolean;
  id: string;
  key: string;
  title: string;
  bytes: number;
};

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

let diagnosticViews = 0;

/** Component fallback diagnostics never execute plugin methods or send replies. */
export async function probeComponent(item: import("./agent/componentTool.js").ComponentItem, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted || diagnosticViews >= 2) return;
  diagnosticViews++;
  try {
    return await withBrowser(async opened => {
      const context = await opened.newContext({ serviceWorkers: "block" });
      const close = () => { void context.close().catch(() => {}); };
      signal.addEventListener("abort", close, { once: true });
      try {
        if (signal.aborted) return;
        const { componentDocument, COMPONENT_CSP } = await import("./components.js");
        const { readFileSync } = await import("node:fs");
        const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
        const html = componentDocument(item, { css: read("kit.css"), js: read("kit.js"), bridge: read("component-bridge.js") }, { token: "capture", capture: true });
        await context.addInitScript(() => { (window as any).__SCRIBE_CAPTURE__ = true; });
        const page = await context.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": COMPONENT_CSP }, body: html }));
        await page.goto("http://component-capture.localhost/", { waitUntil: "domcontentloaded", timeout: 1500 });
        await page.waitForFunction(() => !!(window as any).__componentReport, undefined, { timeout: 1600 });
        return await page.evaluate(() => (window as any).__componentReport);
      } finally { signal.removeEventListener("abort", close); await context.close().catch(() => {}); }
    });
  } finally { diagnosticViews--; }
}

/** A short-lived capture-mode view, sharing the screenshot browser without taking user focus. */
export async function probeTab(id: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || diagnosticViews >= 2 || store.get(id)?.browser) return;
  diagnosticViews += 1;
  try {
    await withBrowser(async opened => {
      if (signal.aborted) return;
      const context = await opened.newContext({ viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, serviceWorkers: "block" });
      const close = () => { void context.close().catch(() => {}); };
      signal.addEventListener("abort", close, { once: true });
      const shot = beginCaptureBoot({});
      try {
        if (signal.aborted) return;
        await context.addInitScript(() => { (window as any).__SCRIBE_CAPTURE__ = true; });
        const page = await context.newPage();
        await page.goto(`${pageViewUrl(id)}?shot=${shot}`, { waitUntil: "commit", timeout: 1500 });
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        endCaptureBoot(shot);
        signal.removeEventListener("abort", close);
        await context.close().catch(() => {});
      }
    });
  } finally {
    diagnosticViews -= 1;
  }
}

export async function captureTab(input: ScreenshotRequest): Promise<ScreenshotResult> {
  const tab = store.get(input.idOrKey);
  if (!tab) {
    throw new Error(`tab not found: ${input.idOrKey}`);
  }
  // The file viewer reads its file through the board (scribe.file), which a headless capture has not.
  if (tab.browser) throw new Error("Browser views cannot be captured; use browser_screenshot");
  if (tab.file) {
    throw new Error("file pages cannot be captured; page_read returns a text file's text or an image file's image");
  }

  const width = clamp(input.width ?? DEFAULT_WIDTH, MIN_VIEWPORT, MAX_VIEWPORT);
  const height = clamp(input.height ?? DEFAULT_HEIGHT, MIN_VIEWPORT, MAX_VIEWPORT);
  const selector = input.selector?.trim() || undefined;
  const click = input.click?.trim() || undefined;
  const fullPage = Boolean(input.fullPage) && !selector;
  const fromViewer = input.fromViewer === true;
  const overlay = parseScreenshotLocal(input.local);
  const embedUrl = embedUrlFromHtml(tab.html);
  if (embedUrl && (fromViewer || overlay)) {
    throw new Error("local and fromViewer do not apply to embed pages; the capture loads the embedded URL directly");
  }
  const seeded = captureLocal(tab.id, fromViewer, overlay);
  const shotId = embedUrl ? undefined : beginCaptureBoot(seeded ?? {});
  const url = screenshotUrl(tab, shotId);

  try {
    return await withBrowser(async (opened) => {
      const context = await opened.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        serviceWorkers: "block",
      });
      try {
        await allowCaptureFraming(context);
        // Also protect Scribe pages loaded inside nested frames.
        await context.addInitScript(() => { (window as any).__SCRIBE_CAPTURE__ = true; });
        const page = await context.newPage();
        await page.goto(url, {
          waitUntil: "load",
          timeout: NAV_TIMEOUT_MS,
        });
        await page.evaluate(() => document.fonts.ready);
        await waitForChildFrames(page);
        if (click) {
          await clickSelector(page, click);
          await page.evaluate(() => document.fonts.ready);
        }
        await sleep(100);

        const shot = selector
          ? await captureSelector(page, selector)
          : await capturePage(page, width, height, fullPage);

        return {
          mimeType: shot.mimeType,
          data: shot.buffer.toString("base64"),
          width: shot.width,
          height: shot.height,
          fullPage,
          selector,
          ...(click ? { click } : {}),
          ...(fromViewer ? { fromViewer: true } : {}),
          ...(seeded && Object.keys(seeded).length ? { local: true } : {}),
          ...(embedUrl ? { embed: true } : {}),
          id: tab.id,
          key: tab.key,
          title: tab.title,
          bytes: shot.buffer.length,
        };
      } finally {
        await context.close();
      }
    });
  } finally {
    if (shotId) {
      endCaptureBoot(shotId);
    }
  }
}

export async function closeScreenshotBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = browser;
  browser = null;
  launching = null;
  if (!current) {
    return;
  }
  try {
    await current.close();
  } catch {
    // Closing on shutdown is best-effort.
  }
}

export function screenshotHttpStatus(message: string): number {
  if (message.startsWith("tab not found")) {
    return 404;
  }
  if (message.startsWith("file pages cannot be captured")) {
    return 400;
  }
  if (
    message.startsWith("selector not found") ||
    message.startsWith("selector is not visible") ||
    message.startsWith("click selector not found") ||
    message.startsWith("click selector is not visible") ||
    message.startsWith("local ") ||
    message.startsWith("local and fromViewer")
  ) {
    return 400;
  }
  if (message.includes("Could not launch")) {
    return 503;
  }
  if (/timeout/i.test(message)) {
    return 504;
  }
  return 500;
}

export function parseScreenshotLocal(value: unknown): BoardState | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error("local must be a JSON object");
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_LOCAL_STATE_BYTES) {
    throw new Error(`local is too large (max ${MAX_LOCAL_STATE_BYTES} bytes)`);
  }
  return value;
}

/** URL the headless browser loads: the embed target when the page is an embed, otherwise /view/:id. */
export function screenshotUrl(tab: { id: string; html: string }, shotId?: string): string {
  const embed = embedUrlFromHtml(tab.html);
  if (embed) {
    return embed;
  }
  const view = pageViewUrl(tab.id);
  return shotId ? `${view}?shot=${shotId}` : view;
}

export function beginCaptureBoot(local: BoardState): string {
  sweepCaptureBoots();
  const id = randomBytes(6).toString("hex");
  captureBoots.set(id, { local, at: Date.now() });
  return id;
}

export function readCaptureBoot(id: string): { local: BoardState } | undefined {
  sweepCaptureBoots();
  if (!SHOT_ID.test(id)) {
    return undefined;
  }
  const boot = captureBoots.get(id);
  return boot ? { local: boot.local } : undefined;
}

export function endCaptureBoot(id: string): void {
  captureBoots.delete(id);
}

export function captureBootOf(value: unknown): { local: BoardState } | undefined {
  return typeof value === "string" ? readCaptureBoot(value) : undefined;
}

function captureLocal(tabId: string, fromViewer: boolean, overlay: BoardState | undefined): BoardState | undefined {
  if (!fromViewer && !overlay) {
    return undefined;
  }
  const base = fromViewer ? store.latestLocal(tabId) : {};
  return { ...base, ...(overlay ?? {}) };
}

function sweepCaptureBoots(): void {
  const cutoff = Date.now() - CAPTURE_BOOT_TTL_MS;
  for (const [id, boot] of captureBoots) {
    if (boot.at < cutoff) {
      captureBoots.delete(id);
    }
  }
}

async function clickSelector(page: Page, selector: string): Promise<void> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) {
    throw new Error(`click selector not found: ${selector}`);
  }
  try {
    await loc.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Error(`click selector is not visible: ${selector}`);
  }
  await loc.click({ timeout: 5_000 });
}

async function waitForChildFrames(page: Page): Promise<void> {
  await Promise.all(
    page.frames().map((frame) => frame.waitForLoadState("load", { timeout: FRAME_WAIT_MS }).catch(() => undefined))
  );
}

async function captureSelector(page: Page, selector: string): Promise<Shot> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) {
    throw new Error(`selector not found: ${selector}`);
  }
  try {
    await loc.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Error(`selector is not visible: ${selector}`);
  }
  const box = await loc.boundingBox();
  const { buffer, mimeType } = await pngOrJpeg((type) => loc.screenshot(shotOptions(type)));
  return {
    buffer,
    mimeType,
    width: Math.max(1, Math.round(box?.width ?? 0)),
    height: Math.max(1, Math.round(box?.height ?? 0)),
  };
}

async function capturePage(page: Page, width: number, height: number, fullPage: boolean): Promise<Shot> {
  const scrollHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  );
  const clipHeight = fullPage ? Math.min(Math.max(scrollHeight, height), MAX_FULL_PAGE_HEIGHT) : height;
  const { buffer, mimeType } = await pngOrJpeg((type) => {
    const opts = shotOptions(type);
    if (!fullPage || clipHeight <= height) {
      return page.screenshot(opts);
    }
    return page.screenshot({
      ...opts,
      clip: { x: 0, y: 0, width, height: clipHeight },
    });
  });
  return {
    buffer,
    mimeType,
    width,
    height: fullPage ? clipHeight : height,
  };
}

export type ImageType = "png" | "jpeg";

type Shot = {
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

export function shotOptions(type: ImageType) {
  return type === "jpeg"
    ? { type: "jpeg" as const, quality: JPEG_QUALITY, animations: "disabled" as const }
    : { type: "png" as const, animations: "disabled" as const };
}

export async function pngOrJpeg(take: (type: ImageType) => Promise<Buffer>): Promise<{
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
}> {
  const png = await take("png");
  if (png.length <= MAX_PNG_BYTES) {
    return { buffer: png, mimeType: "image/png" };
  }
  const jpeg = await take("jpeg");
  return { buffer: jpeg, mimeType: "image/jpeg" };
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  inFlight += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    return await fn(await ensureBrowser());
  } finally {
    inFlight -= 1;
    if (inFlight === 0) {
      idleTimer = setTimeout(() => {
        void closeScreenshotBrowser();
      }, IDLE_CLOSE_MS);
    }
  }
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }
  if (!launching) {
    launching = launchBrowser()
      .then((opened) => {
        browser = opened;
        opened.on("disconnected", () => {
          if (browser === opened) {
            browser = null;
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

function launchBrowser(): Promise<Browser> {
  return launchChromium({ headless: true, args: LAUNCH_ARGS, purpose: "Screenshot" });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
