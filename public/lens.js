/**
 * Library lenses (#260, src/lens.ts): which Library pages a space's lens shows. Pure functions over
 * page meta; library.js supplies the context (folders, unread, chats, About answers).
 */
(function () {
  const DAY = 24 * 60 * 60 * 1000;
  const LEVEL_RANK = { public: 0, open: 1, ask: 2, trusted: 3, restricted: 4 };
  const LEVEL_LABEL = { public: "Open", open: "Normal", ask: "Ask always", trusted: "Trusted only", restricted: "Restricted" };
  const KIND_LABEL = { template: "Template pages", file: "File pages", plain: "Plain pages" };
  const FLAG_LABEL = { pinned: "Pinned", unread: "Unread", chats: "Has chats" };
  const BASIS_LABEL = { activity: "Active", edited: "Edited", created: "Created", closed: "Closed" };

  /** A space's lens, or the one it starts with: its home folder, else what was made in it. */
  function lensOf(space) {
    if (space?.lens) return space.lens;
    return { on: false, match: "all", conditions: [space?.home ? { type: "home" } : { type: "madeIn", spaces: ["this"] }] };
  }

  function normPath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** Whether a path on disk is the folder or inside it ("S:" covers the whole drive). */
  function under(path, folder) {
    const have = normPath(path);
    const want = normPath(folder);
    return Boolean(have && want) && (have === want || have.startsWith(want + "/"));
  }

  /** The same date the Clean up dialog ages a page by. */
  function dateOf(page, basis) {
    const edited = Math.max(page.updatedAt || 0, page.stateUpdatedAt || 0);
    if (basis === "created") return page.createdAt || 0;
    if (basis === "edited") return edited;
    if (basis === "closed") return page.closedAt || 0;
    return Math.max(edited, page.closedAt || 0);
  }

  /** A page's agent access level: its own, unless a folder above it sets a stricter one. */
  function accessOf(page, inherited) {
    const own = page.agentHidden ? "restricted" : page.access?.level || null;
    if (own === "open" && inherited === "public") return "open";
    if (own && (!inherited || LEVEL_RANK[own] >= LEVEL_RANK[inherited])) return own;
    return inherited || "open";
  }

  function inside(ctx, folderId, rootId) {
    return Boolean(folderId && rootId && ctx.subtree(rootId).has(folderId));
  }

  function test(page, cond, ctx) {
    switch (cond.type) {
      case "home":
        return inside(ctx, page.folderId, ctx.home);
      case "folder":
        return cond.folders.some((id) => inside(ctx, page.folderId, id));
      case "madeIn":
        return Boolean(page.madeIn) && cond.spaces.some((id) => (id === "this" ? ctx.spaceId : id) === page.madeIn);
      case "madeBy":
        return cond.by === "agent" ? Boolean(page.provenance?.created) : !page.provenance?.created;
      case "madeFrom": {
        const origin = page.access?.origin;
        if (!origin) return false;
        if (cond.target.kind === "page") return origin.kind === "page" && origin.id === cond.target.id;
        if (origin.kind === "folder") return inside(ctx, origin.id, cond.target.id);
        return inside(ctx, ctx.folderOf(origin.id), cond.target.id);
      }
      case "workspace":
        return under(page.workspace, cond.path);
      case "location":
        return [page.file?.path, ctx.diskPath?.(page.folderId), page.workspace].some((path) => under(path, cond.path));
      case "age": {
        const at = dateOf(page, cond.basis);
        return at > 0 && ctx.now - at <= cond.days * DAY;
      }
      case "kind":
        return cond.kinds.includes(page.templateId ? "template" : page.file ? "file" : "plain");
      case "about":
        return Boolean(ctx.about(cond.text)?.has(page.id));
      case "access":
        return cond.levels.includes(ctx.access(page));
      case "flag":
        if (cond.flag === "pinned") return Boolean(page.pinned);
        if (cond.flag === "unread") return Boolean(ctx.isUnread(page.id));
        return ctx.chats(page.id) > 0;
      default:
        return true;
    }
  }

  /** Whether the lens shows the page. A lens with no conditions shows everything. */
  function matches(page, lens, ctx) {
    const conditions = lens?.conditions || [];
    if (!conditions.length) return true;
    const pass = (cond) => test(page, cond, ctx) !== Boolean(cond.not);
    return lens.match === "any" ? conditions.some(pass) : conditions.every(pass);
  }

  /** A condition in a few words, for the lens line and its editor. names: { folder(id), space(id), page(id) }. */
  function describe(cond, names) {
    const text = (() => {
      switch (cond.type) {
        case "home":
          return "In the home folder";
        case "folder":
          return `In ${cond.folders.map((id) => names.folder(id)).join(" or ")}`;
        case "madeIn":
          return `Made in ${cond.spaces.map((id) => (id === "this" ? "this space" : names.space(id))).join(" or ")}`;
        case "madeBy":
          return cond.by === "agent" ? "Made by an agent" : "Made by you";
        case "madeFrom":
          return `Made from ${cond.target.kind === "page" ? names.page(cond.target.id) : names.folder(cond.target.id)}`;
        case "workspace":
          return `Workspace ${cond.path}`;
        case "location":
          return `On disk in ${cond.path}`;
        case "age":
          return `${BASIS_LABEL[cond.basis] || "Active"} in the last ${cond.days} day${cond.days === 1 ? "" : "s"}`;
        case "kind":
          return cond.kinds.map((kind) => KIND_LABEL[kind]).join(" or ");
        case "about":
          return `About “${cond.text}”`;
        case "access":
          return `Access: ${cond.levels.map((level) => LEVEL_LABEL[level]).join(" or ")}`;
        case "flag":
          return FLAG_LABEL[cond.flag] || cond.flag;
        default:
          return cond.type;
      }
    })();
    return cond.not ? `Not: ${text}` : text;
  }

  const api = { lensOf, matches, describe, accessOf, dateOf, LEVEL_LABEL, KIND_LABEL, FLAG_LABEL, BASIS_LABEL };
  if (typeof window !== "undefined") window.scribeLens = api;
  if (typeof module !== "undefined") module.exports = api;
})();
