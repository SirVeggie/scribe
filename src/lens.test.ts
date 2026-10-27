import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { normalizeLens } from "./lens.js";

type Page = Record<string, unknown> & { id: string };
type Lens = { on: boolean; match: "all" | "any"; conditions: Array<Record<string, unknown>> };
type LensApi = {
  lensOf(space: unknown): Lens;
  matches(page: Page, lens: Lens, ctx: unknown): boolean;
  describe(cond: unknown, names: unknown): string;
};

function loadLens(): LensApi {
  const context: { window: { scribeLens?: LensApi } } = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../public/lens.js", import.meta.url), "utf8"), context);
  return context.window.scribeLens!;
}

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
// Folders: home > sub, other.
const parents: Record<string, string | null> = { home: null, sub: "home", other: null };
function subtree(id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [child, parent] of Object.entries(parents)) {
      if (parent && out.has(parent) && !out.has(child)) {
        out.add(child);
        grew = true;
      }
    }
  }
  return out;
}

const pages: Page[] = [
  { id: "a", folderId: "sub", madeIn: "s1", createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY, templateId: "kanban", pinned: true },
  { id: "b", folderId: "other", madeIn: "s2", createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, provenance: { created: { thread: "th_1", at: 1 } }, access: { origin: { kind: "page", id: "a" } }, workspace: "S:\\Projects\\app\\src" },
  { id: "c", createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, file: { path: "C:/Notes/x.md" }, agentHidden: true, access: { origin: { kind: "folder", id: "sub" } } },
];
const byId = new Map(pages.map((page) => [page.id, page]));
const ctx = {
  spaceId: "s1",
  home: "home",
  now,
  subtree,
  folderOf: (id: string) => byId.get(id)?.folderId ?? null,
  diskPath: (id: string | null) => (id === "sub" ? "C:/Notes/Linked/sub" : null),
  isUnread: (id: string) => id === "b",
  chats: (id: string) => (id === "c" ? 2 : 0),
  access: (page: Page) => (page.agentHidden ? "restricted" : "open"),
  about: (text: string) => (text === "audio" ? new Set(["b"]) : null),
};

function shown(api: LensApi, conditions: Array<Record<string, unknown>>, match: "all" | "any" = "all"): string[] {
  return pages.filter((page) => api.matches(page, { on: true, match, conditions }, ctx)).map((page) => page.id);
}

test("lens conditions pick the pages they describe (#260)", () => {
  const api = loadLens();
  assert.deepEqual(shown(api, []), ["a", "b", "c"]);
  assert.deepEqual(shown(api, [{ type: "home" }]), ["a"]);
  assert.deepEqual(shown(api, [{ type: "folder", folders: ["other"] }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "madeIn", spaces: ["this"] }]), ["a"]);
  assert.deepEqual(shown(api, [{ type: "madeBy", by: "agent" }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "madeBy", by: "me" }]), ["a", "c"]);
  assert.deepEqual(shown(api, [{ type: "madeFrom", target: { kind: "page", id: "a" } }]), ["b"]);
  // A folder origin inside the target counts, and so does a page origin filed in it.
  assert.deepEqual(shown(api, [{ type: "madeFrom", target: { kind: "folder", id: "home" } }]), ["b", "c"]);
  assert.deepEqual(shown(api, [{ type: "workspace", path: "s:/projects/app" }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "workspace", path: "S:\\Projects\\ap" }]), []);
  // Location covers files, disk-linked folders and workspaces; "Not S:" hides the whole drive (#64).
  assert.deepEqual(shown(api, [{ type: "location", path: "S:" }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "location", path: "C:/Notes/" }]), ["a", "c"]);
  assert.deepEqual(shown(api, [{ type: "location", path: "c:/notes/linked" }]), ["a"]);
  assert.deepEqual(shown(api, [{ type: "location", path: "S:", not: true }]), ["a", "c"]);
  assert.deepEqual(shown(api, [{ type: "age", basis: "created", days: 7 }]), ["a", "c"]);
  assert.deepEqual(shown(api, [{ type: "kind", kinds: ["file", "template"] }]), ["a", "c"]);
  assert.deepEqual(shown(api, [{ type: "about", text: "audio" }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "about", text: "not loaded yet" }]), []);
  assert.deepEqual(shown(api, [{ type: "access", levels: ["restricted"] }]), ["c"]);
  assert.deepEqual(shown(api, [{ type: "flag", flag: "pinned" }]), ["a"]);
  assert.deepEqual(shown(api, [{ type: "flag", flag: "unread" }]), ["b"]);
  assert.deepEqual(shown(api, [{ type: "flag", flag: "chats" }]), ["c"]);
});

test("a lens combines with all or any, and not flips one condition", () => {
  const api = loadLens();
  assert.deepEqual(shown(api, [{ type: "home" }, { type: "flag", flag: "unread" }], "any"), ["a", "b"]);
  assert.deepEqual(shown(api, [{ type: "age", days: 7 }, { type: "kind", kinds: ["template"], not: true }]), ["c"]);
  assert.equal(api.describe({ type: "age", basis: "edited", days: 1, not: true }, {}), "Not: Edited in the last 1 day");
});

test("a space starts with its home folder lens, else what was made in it", () => {
  const api = loadLens();
  assert.equal(JSON.stringify(api.lensOf({ id: "s1", home: "home" }).conditions), JSON.stringify([{ type: "home" }]));
  assert.equal(JSON.stringify(api.lensOf({ id: "s1" }).conditions), JSON.stringify([{ type: "madeIn", spaces: ["this"] }]));
  assert.equal(api.lensOf({ id: "s1" }).on, false);
});

test("normalizeLens keeps only well-formed conditions", () => {
  assert.equal(normalizeLens("nope"), undefined);
  assert.deepEqual(
    normalizeLens({
      on: true,
      match: "weird",
      conditions: [
        { type: "folder", folders: [] },
        { type: "kind", kinds: ["file", "bogus"] },
        { type: "madeFrom", target: { kind: "page", id: " t_1 " } },
        { type: "age", days: -1 },
        { type: "flag", flag: "chats", not: true },
      ],
    }),
    { on: true, match: "all", conditions: [{ type: "kind", kinds: ["file"] }, { type: "madeFrom", target: { kind: "page", id: "t_1" } }, { type: "flag", flag: "chats", not: true }] }
  );
});
