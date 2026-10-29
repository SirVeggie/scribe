/**
 * Page permissions: what a page's own code may do beyond its state (run agents without a click,
 * with file and shell access, …). The daemon stores the user's choices per page and checks them;
 * this asks the user when a page needs one it doesn't have yet, and holds the tab menu's
 * Permissions… dialog. Pages never reach the routes behind it.
 */
(() => {
  /** The access ladder (#719), lowest first. Older grants said "ask" (Ask first), now Edits. */
  const APPROVALS = [
    { id: "readonly", label: "Read-only" },
    { id: "board", label: "Board" },
    { id: "edits", label: "Edits" },
    { id: "auto", label: "Auto review" },
    { id: "full", label: "Full access" },
  ];
  const VALUES = [
    { id: "ask", label: "Ask" },
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ];
  const app = () => window.scribeApp;

  async function request(method, id, suffix = "", body) {
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/permissions${suffix}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    if (!res) throw new Error("Scribe is not reachable");
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || `Permissions request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function list(id) {
    return (await request("GET", id)).permissions || [];
  }

  /** A per-folder permission's levels: its own (files: Read, Write, Read & write) or the approval rungs. */
  function levelsOf(def) {
    return def.levels || APPROVALS;
  }

  function levelLabel(def, id) {
    return levelsOf(def).find((a) => a.id === (id === "ask" && !def.levels ? "edits" : id))?.label || id;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A plain-text hover tip (public/tooltip.js), also read out to screen readers. */
  function tip(node, text) {
    node.dataset.tooltip = text;
    node.setAttribute("aria-description", text);
    return node;
  }

  /* ---------- asking ---------- */

  /** One prompt at a time; the same question from the same page shares its answer. */
  let chain = Promise.resolve();
  const asking = new Map();
  /** "Not now" holds off the same question for a while, so a page can't ask in a loop; scribe.permissions.request still asks. */
  const LATER_MS = 10 * 60 * 1000;
  const later = new Map();

  function askKey(tab, need) {
    return [tab.id, need.perm, need.folder || "", need.approval || ""].join("\n");
  }

  /** Resolves { value: "allow" | "deny", keep }, or null (not now). */
  function prompt(tab, def, need, explicit) {
    const key = askKey(tab, need);
    if (asking.has(key)) return asking.get(key);
    if (!explicit && (later.get(key) || 0) > Date.now()) return Promise.resolve(null);
    const answer = chain.then(() => showPrompt(tab, def, need));
    chain = answer.catch(() => null);
    asking.set(key, answer);
    answer.then(
      (value) => {
        asking.delete(key);
        if (value) later.delete(key);
        else later.set(key, Date.now() + LATER_MS);
      },
      () => asking.delete(key)
    );
    return answer;
  }

  function showPrompt(tab, def, need) {
    const current = app()?.findAnyTab(tab.id) || tab;
    const dlg = el("dialog", "confirm permission-ask");
    const form = el("form");
    form.method = "dialog";
    const body = el("div", "permission-ask-body");
    const head = el("h2", "", `“${current.title || "This page"}” wants to:`);
    const what = el("p", "permission-ask-what", def.label);
    const detail = el("p", "permission-ask-detail", def.detail);
    body.append(head, what, detail);
    if (def.perFolder) {
      const where = el("dl", "permission-ask-where");
      where.append(el("dt", "", "Folder"), el("dd", "permission-path", need.folder || "?"));
      where.append(el("dt", "", def.levelName || "Approval"), el("dd", "", levelLabel(def, need.approval || levelsOf(def)[0].id)));
      body.append(where);
    }
    let keep = null;
    if (def.risky) {
      // Risky grants reset when an agent rewrites the page; the user may keep this one (#895).
      const label = el("label", "ag-check permission-ask-keep");
      keep = el("input");
      keep.type = "checkbox";
      label.append(keep, el("span", null, "Don't ask again when an agent updates this page"));
      body.append(label);
    }
    body.append(el("p", "permission-ask-note", "You can change this later from the tab menu: Permissions…"));
    const actions = el("div", "confirm-actions");
    const later = el("button", "", "Not now");
    later.type = "submit";
    later.value = "later";
    const deny = el("button", "danger", "Deny");
    deny.type = "submit";
    deny.value = "deny";
    const allow = el("button", "primary", "Allow");
    allow.type = "submit";
    allow.value = "allow";
    actions.append(later, deny, allow);
    form.append(body, actions);
    dlg.append(form);
    document.body.append(dlg);
    dlg.returnValue = "later";
    dlg.showModal();
    later.focus();
    return new Promise((resolve) => {
      dlg.addEventListener(
        "close",
        () => {
          const value = dlg.returnValue;
          dlg.remove();
          resolve(value === "allow" || value === "deny" ? { value, keep: Boolean(keep?.checked) } : null);
        },
        { once: true }
      );
    });
  }

  /** Store the user's answer: a per-folder permission gains the folder, the rest are set as a whole. */
  async function remember(tab, def, need, { value: answer, keep }) {
    const kept = def.risky ? { keep } : {};
    if (answer === "allow" && def.perFolder) {
      const same = (f) => f.path.toLowerCase() === String(need.folder).toLowerCase();
      const folders = (def.folders || []).filter((f) => !same(f));
      let level = need.approval || levelsOf(def)[0].id;
      // Write on a folder the page could already read (or the other way round) keeps both.
      const before = (def.folders || []).find(same)?.approval;
      if (def.id === "files" && before && before !== level) level = "readwrite";
      folders.push({ path: need.folder, approval: level });
      await request("PUT", tab.id, "", { perm: def.id, value: def.value === "deny" ? "ask" : def.value, folders, ...kept });
      return;
    }
    await request("PUT", tab.id, "", { perm: def.id, value: answer, ...kept });
  }

  /**
   * Whether `tab` may do what `need` ({ perm, folder?, approval? }) describes, asking the user when
   * it hasn't decided yet. Resolves { ok: true } or { ok: false, error: "denied", permission }.
   * explicit: the page asked for it with scribe.permissions.request, after a click.
   */
  async function ensure(tab, need, { explicit = false } = {}) {
    if (Array.isArray(need)) {
      // A listen request asks for the microphone and transcription in a single dialog.
      const defs = await list(tab.id).catch(() => []);
      const pending = [];
      for (const item of need) {
        const result = (await request("POST", tab.id, "/check", item)).result;
        if (result === "deny") return { ok: false, error: "denied", permission: item.perm };
        if (result === "ask") {
          const def = defs.find(p => p.id === item.perm);
          if (!def) return { ok: false, error: "denied", permission: item.perm };
          pending.push({ def, item });
        }
      }
      if (!pending.length) return { ok: true };
      const answer = await prompt(tab, { label: pending.map(p => p.def.label).join(" and "),
        detail: pending.map(p => p.def.detail).join(" "), risky: pending.some(p => p.def.risky) }, { perm: pending.map(p => p.item.perm).join("+") }, explicit);
      if (answer) for (const p of pending) await remember(tab, p.def, p.item, answer);
      return answer?.value === "allow" ? { ok: true } : { ok: false, error: "denied", permission: pending[0].item.perm };
    }
    const denied = { ok: false, error: "denied", permission: need.perm };
    let result;
    try {
      result = (await request("POST", tab.id, "/check", need)).result;
    } catch (err) {
      // A daemon from before page permissions: only what pages could always do.
      return err.status === 404 && need.perm === "agent.chat" ? { ok: true } : denied;
    }
    if (result === "allow") return { ok: true };
    if (result !== "ask") return denied;
    const def = (await list(tab.id).catch(() => [])).find((p) => p.id === need.perm);
    if (!def) return denied;
    const answer = await prompt(tab, def, need, explicit);
    if (!answer) return denied;
    try {
      await remember(tab, def, need, answer);
    } catch (err) {
      app()?.showNotice?.(err.message);
      return denied;
    }
    return answer.value === "allow" ? { ok: true } : denied;
  }

  /** The page's permissions as it may see them: ids, labels, values, and approved folders. */
  async function query(tab) {
    try {
      const perms = await list(tab.id);
      return {
        ok: true,
        permissions: perms.map((p) => ({ id: p.id, label: p.label, value: p.value, ...(p.perFolder ? { folders: p.folders || [] } : {}) })),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ---------- the Permissions… dialog ---------- */

  function selectOf(options, value, label, onChange) {
    const select = el("select");
    select.setAttribute("aria-label", label);
    for (const option of options) {
      const opt = el("option", "", option.label);
      opt.value = option.id;
      select.append(opt);
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return window.createSelect ? window.createSelect(select) : select;
  }

  async function manage(id) {
    const tab = app()?.findAnyTab(id);
    if (!tab) return;
    let perms;
    try {
      perms = await list(id);
    } catch (err) {
      app()?.showNotice?.(err.status === 404 ? "Restart Scribe to manage page permissions" : err.message);
      return;
    }
    const dlg = el("dialog", "confirm permissions");
    const form = el("form");
    form.method = "dialog";
    const head = el("h2", "", "Permissions");
    const help = tip(el("button", "search-help", "?"), `What “${tab.title}” may do. Kept on this PC, not exported; an agent changing the page's code resets the risky ones unless kept.`);
    help.type = "button";
    help.setAttribute("aria-label", "About page permissions");
    head.append(" ", help);
    const rows = el("div", "permissions-rows");
    const actions = el("div", "confirm-actions");
    const done = el("button", "", "Done");
    done.type = "submit";
    done.value = "done";
    actions.append(done);
    form.append(head, rows, actions);
    dlg.append(form);

    const save = async (body) => {
      try {
        perms = (await request("PUT", id, "", body)).permissions || perms;
      } catch (err) {
        app()?.showNotice?.(err.message);
      }
      render();
    };

    const render = () => {
      rows.replaceChildren();
      for (const p of perms) {
        const row = el("div", "permission-row");
        const text = el("div", "permission-text");
        text.append(p.detail ? tip(el("span", "permission-label setting-hinted", p.label), p.detail) : el("span", "permission-label", p.label));
        const values = p.perFolder ? VALUES.filter((v) => v.id !== "allow") : VALUES;
        const value = p.perFolder && p.value === "allow" ? "ask" : p.value;
        row.append(text, selectOf(values, value, p.label, (next) => save({ perm: p.id, value: next })));
        rows.append(row);
        if (p.risky && (p.value !== p.default || p.folders?.length)) {
          const label = el("label", "ag-check permission-keep");
          const box = el("input");
          box.type = "checkbox";
          box.checked = Boolean(p.keep);
          box.addEventListener("change", () => save({ perm: p.id, value: p.value, keep: box.checked }));
          label.append(box, el("span", null, "Keep when an agent updates the page"));
          rows.append(label);
        }
        if (!p.perFolder) continue;
        const folders = el("div", "permission-folders");
        if (!p.folders?.length) {
          folders.append(el("div", "permission-empty", "No folders approved yet. The page asks when it needs one."));
        }
        for (const folder of p.folders || []) {
          const line = el("div", "permission-folder");
          const others = () => (p.folders || []).filter((f) => f !== folder);
          const remove = el("button", "permission-remove", "Remove");
          remove.type = "button";
          remove.addEventListener("click", () => save({ perm: p.id, value: value, folders: others() }));
          line.append(
            el("span", "permission-path", folder.path),
            selectOf(levelsOf(p), folder.approval === "ask" && !p.levels ? "edits" : folder.approval, `${p.levelName || "Approval"} in ${folder.path}`, (approval) =>
              save({ perm: p.id, value: value, folders: (p.folders || []).map((f) => (f === folder ? { ...f, approval } : f)) })
            ),
            remove
          );
          folders.append(line);
        }
        rows.append(folders);
      }
    };

    render();
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    dlg.showModal();
    done.focus();
  }

  window.scribePermissions = { ensure, query, manage };
})();
