import { createHash } from "node:crypto";
import { store } from "../store.js";
import { readStoredAsset } from "../assets.js";
import { dataDir } from "../config.js";
import { searchEmbedder } from "./embedder.js";
import { detectSearchPack, searchEnabled } from "./pack.js";
import { SearchIndex, type ImageAsset } from "./indexer.js";
import type { Tab } from "../types.js";

/** Formats the pack's image decoder reads. SVG and icons are left out. */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/i;
const fileHashes = new Map<string, string>();
/** A page's images: the blobs its code saved (immutable, so the id is the hash) and the files given to page_show. */
function imageAssets(tab: Tab): ImageAsset[] {
  const out: ImageAsset[] = [];
  for (const asset of store.listPageAssets(tab.id).assets) {
    if (IMAGE_TYPE.test(asset.mimeType)) out.push({ ref: asset.id, name: asset.name, hash: asset.id, read: () => store.readPageAsset(asset.id)?.data });
  }
  for (const asset of tab.assets ?? []) {
    if (!IMAGE_TYPE.test(asset.mimeType)) continue;
    // page_show can replace a file under the same name; that updates the page, so hash again only then.
    const key = `${tab.id}/${asset.name}`, version = `${asset.bytes}:${tab.updatedAt}:`;
    let hash = fileHashes.get(key);
    if (!hash?.startsWith(version)) {
      const data = readStoredAsset(tab.id, asset.name);
      if (!data) continue;
      hash = version + createHash("sha256").update(data).digest("hex");
      fileHashes.set(key, hash);
    }
    out.push({ ref: `asset:${asset.name}`, name: asset.name, hash: hash.slice(version.length), read: () => readStoredAsset(tab.id, asset.name) });
  }
  return out;
}

export const searchIndex = new SearchIndex(dataDir, {
  pages: () => [...store.listOpenTabs(), ...store.listClosedTabs()].filter(tab => !tab.temp),
  get: id => { const tab = store.get(id); return tab?.temp ? undefined : tab; },
  folder: tab => store.folderPath(tab.folderId),
  declaration: tab => store.searchDeclaration(tab),
  assets: imageAssets,
}, searchEmbedder);

let attached = false;
let replacingPack = false;
export function setSearchPackReplacing(value: boolean): void { replacingPack = value; }
/** Look at every page again (a protected value was added or removed, #1045); unchanged chunks keep their vectors. */
export function reindexAllPages(): void {
  for (const tab of [...store.listOpenTabs(), ...store.listClosedTabs()]) searchIndex.schedule(tab.id);
}
export function refreshSearchIndex(): void {
  if (replacingPack) { searchIndex.pause(); return; }
  if (!attached) {
    attached = true;
    // A temporary page (#655) is not in the Library; Keep in Library upserts it again.
    store.on("tab_upserted", (tab: { id: string; temp?: boolean }) => { if (!tab.temp) searchIndex.schedule(tab.id); });
    store.on("tab_state", (tab: { id: string }) => searchIndex.schedule(tab.id));
    store.on("tab_deleted", (id: string) => searchIndex.remove(id));
    store.on("page_assets_removed", (id: string) => searchIndex.schedule(id));
    store.on("folders", () => { for (const tab of [...store.listOpenTabs(), ...store.listClosedTabs()]) searchIndex.schedule(tab.id); });
    store.on("template_upserted", () => { for (const tab of [...store.listOpenTabs(), ...store.listClosedTabs()]) searchIndex.schedule(tab.id); });
  }
  const pack = detectSearchPack();
  if (searchEnabled() && pack.status === "ready" && pack.pack) {
    try { searchIndex.start(pack.pack.model, pack.pack.dtype); }
    catch (error) { searchIndex.fail(error); searchEmbedder.stop(); }
  }
  else { searchIndex.pause(); searchEmbedder.stop(); }
}
