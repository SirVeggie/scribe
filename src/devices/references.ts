/**
 * References to another device's pages, cards and threads (#908): `scribe:@laptop/thesis-plan`,
 * `scribe:@laptop/board#card=12`, `thread:@laptop/th_…`. The device part is a device id or name, matched
 * on a slug of the name ("Work laptop" is `@work-laptop`) and on the names it had before, so a rename
 * doesn't break the links written with the old one.
 *
 * The board asks its own daemon (`POST /api/devices/resolve`), which looks the targets up on the device
 * that owns them (`POST /api/devices/describe` over the link) and remembers the titles it saw, so a link
 * to a device that went offline keeps its label. Nothing here is page specific beyond the lookup, so a
 * page hosted on another device (a synced page, later) can sit in the Library as such a target.
 */

export type DeviceRef = { device: string; kind: "page" | "thread"; ref: string };

const REF = /^(scribe|thread):@([^/\s#]+)\/([^#\s]+)$/i;

/** A device reference without its #anchor, or null for anything else (a local key, a URL, a file). */
export function parseDeviceRef(target: unknown): DeviceRef | null {
  const text = typeof target === "string" ? target.trim() : "";
  const m = REF.exec(text.split("#")[0]);
  if (!m) return null;
  const ref = m[3].replace(/^(scribe:)+/i, "");
  if (!ref) return null;
  return { device: m[2].toLowerCase(), kind: m[1].toLowerCase() === "thread" ? "thread" : "page", ref };
}

/** How a device name is written in a link: lower case, runs of anything but letters and digits as one dash. */
export function deviceSlug(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

export type NamedDevice = { id: string; name: string; formerNames?: string[] };

/** The device a link's `@token` names: its id, then its current name, then a name it had before. */
export function findDevice<T extends NamedDevice>(token: string, devices: T[]): T | undefined {
  const want = token.toLowerCase();
  const slug = deviceSlug(token);
  return devices.find((d) => d.id === want)
    ?? devices.find((d) => deviceSlug(d.name) === slug)
    ?? devices.find((d) => d.formerNames?.some((name) => deviceSlug(name) === slug));
}

/** A name the device used to have, kept (newest first, at most a few) when it is renamed. */
export function rememberName(formerNames: string[] | undefined, oldName: string, newName: string): string[] | undefined {
  if (deviceSlug(oldName) === deviceSlug(newName)) return formerNames;
  const keep = (formerNames ?? []).filter((name) => deviceSlug(name) !== deviceSlug(oldName) && deviceSlug(name) !== deviceSlug(newName));
  return [oldName, ...keep].slice(0, 5);
}

/** What the owning device says about its targets: a title, or null when it has no such page or thread. */
export type Described = { pages: Record<string, { id: string; key: string; title: string } | null>; threads: Record<string, { title: string } | null> };

/** One resolved target, as the board's links and hover cards show it. */
export type Resolved =
  | { here: true; device: { id: string; name: string } }
  | { unknown: true }
  | {
    device: { id: string; name: string };
    online: boolean;
    /** The page or thread is gone on that device (only known while it is online). */
    missing?: boolean;
    title?: string;
    /** For a page, its key on that device. */
    key?: string;
  };
