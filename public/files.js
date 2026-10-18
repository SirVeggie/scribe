/**
 * Files on disk in the board (#707): the kind badge file pages show in the Library and the tab
 * strip, and where a Library folder is on disk (its own link, else its parent's plus its name).
 */
(() => {
  const KINDS = {
    md: ["MD", "md"], markdown: ["MD", "md"], mdx: ["MD", "md"],
    json: ["{ }", "json"], jsonc: ["{ }", "json"], json5: ["{ }", "json"],
    txt: ["TXT", "txt"], log: ["LOG", "txt"], csv: ["CSV", "txt"],
    pdf: ["PDF", "pdf"],
    html: ["HTML", "code"], htm: ["HTML", "code"],
  };
  const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

  function extOf(name) {
    const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1) : "";
  }

  /** The badge's text and colour class for a file name. */
  function kindOf(name) {
    const ext = extOf(name);
    if (KINDS[ext]) return { label: KINDS[ext][0], kind: KINDS[ext][1] };
    if (IMAGES.has(ext)) return { label: "IMG", kind: "img" };
    if (!ext) return { label: "FILE", kind: "txt" };
    return { label: ext.slice(0, 4).toUpperCase(), kind: "code" };
  }

  function badge(name) {
    const { label, kind } = kindOf(name);
    const el = document.createElement("span");
    el.className = `file-badge k-${kind}`;
    el.textContent = label;
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  const SAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

  /** Where a Library folder is on disk, or null; mirrors the daemon's folderDiskPath. */
  function diskPath(folders, folderId) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const names = [];
    let at = folderId ? byId.get(folderId) : null;
    for (let depth = 0; at && depth < 64; depth++) {
      if (at.disk) {
        const sep = /\\/.test(at.disk) || /^[A-Za-z]:/.test(at.disk) ? "\\" : "/";
        return [at.disk.replace(/[\\/]+$/, ""), ...names.reverse()].join(sep);
      }
      names.push(String(at.name || "").replace(SAFE, "_").trim() || "file");
      at = at.parentId ? byId.get(at.parentId) : null;
    }
    return null;
  }

  window.scribeFiles = { kindOf, badge, diskPath };
})();
