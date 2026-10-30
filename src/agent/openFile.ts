import fs from "node:fs/promises";
import { scopedReadResolver, type ReadOptions, type ReadScope } from "./readFile.js";
import type { Tab } from "../types.js";

type FilePageStore = {
  openFilePage(input: { path: string; temp?: boolean; activate?: boolean }): { tab: Tab; created: boolean };
};

/**
 * page_open's file (#655): an agent opens a file as a page for the user, only when it may read that
 * file itself (its workspace and read roots, or anywhere in Code mode with Full access; the same
 * check as read_file). Temporary unless keep, and shown as a focused tab.
 */
export async function openFileForAgent(
  thread: ReadScope | null,
  store: FilePageStore,
  input: { path?: unknown; keep?: unknown },
  opts: ReadOptions = {}
): Promise<{ tab: Tab; created: boolean }> {
  const resolve = await scopedReadResolver(thread, opts);
  const { target } = await resolve(input.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error(`not a file: ${target}`);
  }
  return store.openFilePage({ path: target, temp: input.keep !== true, activate: true });
}
