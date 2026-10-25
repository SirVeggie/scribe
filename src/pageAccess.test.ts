import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveLevel, frameReach, normalizePageAccess, normalizeThreadPageGrants, pageReach, type AccessLookup, type AccessPage, type PageReader } from "./pageAccess.js";
import type { FolderAccess, PageAccess } from "./types.js";

// Library: work/ (with work/secret/ inside) and notes/. Pages are by id.
const folders: Record<string, { parent: string | null; access?: FolderAccess }> = {
  work: { parent: null },
  secret: { parent: "work" },
  notes: { parent: null },
};
const pages: Record<string, AccessPage> = {
  board: { id: "board", folderId: "work" },
  report: { id: "report", folderId: "notes" },
  plan: { id: "plan", folderId: "work" },
  diary: { id: "diary", folderId: "secret" },
  loose: { id: "loose" },
};

function lookup(over: { folders?: Record<string, FolderAccess>; pages?: Record<string, PageAccess> } = {}): AccessLookup {
  return {
    folderChain(folderId) {
      const out: string[] = [];
      for (let at = folderId ?? null; at; at = folders[at]?.parent ?? null) out.push(at);
      return out;
    },
    folderAccess: (id) => over.folders?.[id] ?? folders[id]?.access,
    pageFolder: (id) => pages[id]?.folderId,
    pageAccess: (id) => over.pages?.[id] ?? pages[id]?.access,
  };
}

const reader = (over: Partial<PageReader> = {}): PageReader => ({ thread: "t1", scope: { kind: "page", ref: "board" }, trusted: false, grants: [], ...over });

test("a page chat reaches its page and asks for the rest; global reaches every open page", () => {
  const l = lookup();
  assert.equal(pageReach(reader(), pages.board, l), "allow");
  assert.equal(pageReach(reader(), pages.plan, l), "ask");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "work" } }), pages.plan, l), "allow");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "work" } }), pages.diary, l), "allow");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "work" } }), pages.report, l), "ask");
  assert.equal(pageReach(reader({ scope: { kind: "global", ref: null } }), pages.report, l), "allow");
  assert.equal(pageReach(reader({ scope: { kind: "workspace", ref: null } }), pages.board, l), "hidden");
});

test("origin, the thread's own pages, home grants and thread grants open the way", () => {
  const l = lookup();
  const made = { ...pages.report, access: { origin: { kind: "page" as const, id: "board" } } };
  assert.equal(pageReach(reader(), made, l), "allow", "created from the board");
  assert.equal(pageReach(reader(), { ...pages.report, createdBy: "t1" }, l), "allow", "created by this thread");
  const granted = lookup({ pages: { board: { grants: [{ kind: "folder", id: "notes" }] } } });
  assert.equal(pageReach(reader(), pages.report, granted), "allow", "the board was granted notes/");
  const folderGrant = lookup({ folders: { work: { grants: [{ kind: "page", id: "report" }] } } });
  assert.equal(pageReach(reader(), pages.report, folderGrant), "allow", "the board's folder holds the grant");
  assert.equal(pageReach(reader({ grants: [{ kind: "page", id: "report" }] }), pages.report, l), "allow");
  assert.equal(pageReach(reader({ formerScopes: [{ kind: "global", ref: null }] }), pages.report, l), "allow", "a former home still counts");
});

test("the strictest level up the tree wins", () => {
  const l = lookup({ folders: { work: { level: "ask" }, secret: { level: "trusted" } } });
  assert.equal(effectiveLevel(pages.plan, l), "ask");
  assert.equal(effectiveLevel(pages.diary, l), "trusted");
  assert.equal(effectiveLevel({ ...pages.diary, agentHidden: true }, l), "restricted");
  assert.equal(effectiveLevel({ ...pages.plan, access: { level: "trusted" } }, l), "trusted");
});

test("Open reaches every chat with Scribe access; a folder's Open covers its pages unless one sets a level", () => {
  const style = { ...pages.report, access: { level: "public" as const } };
  assert.equal(pageReach(reader(), style, lookup()), "allow", "a board chat outside notes/");
  assert.equal(pageReach(reader({ scope: { kind: "workspace", ref: null } }), style, lookup()), "hidden");
  const open = lookup({ folders: { notes: { level: "public" } } });
  assert.equal(effectiveLevel(pages.report, open), "public");
  assert.equal(pageReach(reader(), pages.report, open), "allow");
  assert.equal(effectiveLevel({ ...pages.report, access: { level: "open" } }, open), "open", "Normal set on the page");
  assert.equal(effectiveLevel({ ...pages.report, access: { level: "ask" } }, open), "ask");
  assert.equal(effectiveLevel(style, lookup({ folders: { notes: { level: "ask" } } })), "ask", "a stricter folder wins");
  assert.equal(effectiveLevel(pages.report, lookup()), "open", "Normal is the default");
});

test("Ask always takes a grant for the thread itself, whatever the scope or home grants", () => {
  const l = lookup({ pages: { plan: { level: "ask" }, board: { grants: [{ kind: "page", id: "plan" }] } } });
  const plan = { ...pages.plan, access: { level: "ask" as const } };
  assert.equal(pageReach(reader({ scope: { kind: "global", ref: null } }), plan, l), "ask");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "work" } }), plan, l), "ask");
  assert.equal(pageReach(reader(), { ...plan, createdBy: "t1" }, l), "ask");
  assert.equal(pageReach(reader({ grants: [{ kind: "folder", id: "work" }] }), plan, l), "allow");
  assert.equal(pageReach(reader({ scope: { kind: "page", ref: "plan" } }), plan, l), "allow", "its own chat");
});

test("Trusted only: untrusted chats cannot find it, but can ask by key and use their own grant", () => {
  const l = lookup({ folders: { secret: { level: "trusted" } } });
  const global = { scope: { kind: "global" as const, ref: null } };
  assert.equal(pageReach(reader({ ...global }), pages.diary, l), "request");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "secret" } }), pages.diary, l), "request", "its home does not open it");
  assert.equal(pageReach(reader({ ...global, grants: [{ kind: "page", id: "diary" }] }), pages.diary, l), "allow");
  assert.equal(pageReach(reader({ ...global, trusted: true }), pages.diary, l), "allow");
  assert.equal(pageReach(reader({ trusted: true }), pages.diary, l), "ask", "trusted, but outside its scope");
});

test("Restricted: only a chat on that page, or the user's @mention", () => {
  const l = lookup();
  const diary = { ...pages.diary, agentHidden: true };
  assert.equal(pageReach(reader({ scope: { kind: "global", ref: null }, trusted: true }), diary, l), "hidden");
  assert.equal(pageReach(reader({ scope: { kind: "folder", ref: "secret" }, trusted: true }), diary, l), "hidden");
  assert.equal(pageReach(reader({ scope: { kind: "page", ref: "diary" } }), diary, l), "allow");
  assert.equal(pageReach(reader({ grants: [{ kind: "page", id: "diary" }] }), diary, l), "hidden", "a plain grant is not enough");
  assert.equal(pageReach(reader({ grants: [{ kind: "page", id: "diary", mention: true }] }), diary, l), "allow");
  const trustedOnly = lookup({ folders: { secret: { level: "trusted" } } });
  assert.equal(pageReach(reader({ grants: [{ kind: "folder", id: "secret", mention: true }] }), pages.diary, trustedOnly), "allow", "a mention beats Trusted only");
});

test("stored access is normalized", () => {
  assert.equal(normalizePageAccess({ level: "restricted" }), undefined, "Restricted is agentHidden, not a page level");
  assert.deepEqual(normalizePageAccess({ level: "ask", origin: { kind: "page", id: "p1" }, grants: [{ kind: "folder", id: "f" }, { kind: "folder", id: "f" }, { kind: "x" }] }), {
    level: "ask",
    origin: { kind: "page", id: "p1" },
    grants: [{ kind: "folder", id: "f" }],
  });
  assert.deepEqual(normalizeThreadPageGrants([{ kind: "page", id: "a" }, { kind: "page", id: "a", mention: true }]), [{ kind: "page", id: "a", mention: true }]);
});

test("a page's script reaches its own page and Open pages its page or folders were granted (#660)", () => {
  const plain = lookup();
  assert.equal(frameReach("board", pages.board, plain), true);
  assert.equal(frameReach("board", pages.plan, plain), false, "same folder is not a grant");
  const made = { ...pages.report, access: { origin: { kind: "page" as const, id: "board" } } };
  assert.equal(frameReach("board", made, plain), false, "origin is an agent rule, not a page's");
  const granted = lookup({ pages: { board: { grants: [{ kind: "page", id: "report" }] } }, folders: { work: { grants: [{ kind: "folder", id: "secret" }] } } });
  assert.equal(frameReach("board", pages.report, granted), true);
  assert.equal(frameReach("board", pages.diary, granted), true, "its folder's grant");
  assert.equal(frameReach("report", pages.board, granted), false, "grants go one way");
  const strict = { ...pages.report, access: { level: "ask" as const } };
  assert.equal(frameReach("board", strict, granted), false, "Ask always needs a chat's own grant");
  assert.equal(frameReach("board", { ...pages.report, agentHidden: true }, granted), false, "Restricted");
});

test("read-only grants open reads of Normal and Open pages, never writes or stricter pages (#818)", () => {
  const home = lookup({ pages: { board: { grants: [{ kind: "page", id: "report", read: true }] } } });
  assert.equal(pageReach(reader(), pages.report, home, true), "allow", "a card link lets board chats read");
  assert.equal(pageReach(reader(), pages.report, home), "ask", "but not change");
  const own = reader({ grants: [{ kind: "page", id: "report", read: true }] });
  assert.equal(pageReach(own, pages.report, lookup(), true), "allow", "a pasted key lets the thread read");
  assert.equal(pageReach(own, pages.report, lookup()), "ask");
  const strict = { ...pages.report, access: { level: "ask" as const } };
  assert.equal(pageReach(own, strict, lookup(), true), "ask", "Ask always still asks");
  assert.equal(pageReach({ ...own, trusted: false }, { ...pages.report, access: { level: "trusted" as const } }, lookup(), true), "request", "Trusted only still asks");
  assert.equal(frameReach("board", pages.report, home), true, "page scripts only read anyway");
});

test("a grant is widened, never narrowed (#818)", () => {
  assert.deepEqual(normalizeThreadPageGrants([{ kind: "page", id: "a", read: true }, { kind: "page", id: "a" }]), [{ kind: "page", id: "a" }]);
  assert.deepEqual(normalizeThreadPageGrants([{ kind: "page", id: "a" }, { kind: "page", id: "a", read: true }]), [{ kind: "page", id: "a" }]);
  assert.deepEqual(normalizeThreadPageGrants([{ kind: "page", id: "a", read: true, mention: true }]), [{ kind: "page", id: "a", mention: true }]);
  assert.deepEqual(normalizePageAccess({ grants: [{ kind: "page", id: "a", read: true }] }), { grants: [{ kind: "page", id: "a", read: true }] });
});
