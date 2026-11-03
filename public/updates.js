/* App updates (#942): the Updates category of Settings, and the notice that offers an update. */
(function () {
  "use strict";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, run, className) => {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  };
  const MODES = [
    ["auto", "Automatically"],
    ["ask", "Ask first"],
    ["ignore", "Don't check"],
  ];

  let view = null;
  let restarting = false;
  let busy = false;

  async function request(method, path, body) {
    const response = await fetch(`/api/updates${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.view) render(data.view);
      throw new Error(data.error || `Update request failed (${response.status})`);
    }
    return data;
  }

  /* ---------- Settings → Updates ---------- */

  const section = el("section", "settings-section updates-section");
  const heading = el("h3", null, "Updates");
  const help = button("?", () => {}, "search-help");
  help.dataset.tooltip = "A git checkout updates to new commits on its upstream branch and rebuilds; an installed release downloads the next release. Automatic updates install once Scribe has been idle for 15 minutes with no chat running, then restart it.";
  help.setAttribute("aria-description", help.dataset.tooltip);
  help.setAttribute("aria-label", "About updates");
  heading.append(" ", help);

  const modeRow = el("div", "setting-row");
  const modeLabel = el("label", null, "Install updates");
  const mode = el("select");
  mode.id = "updates-mode";
  for (const [value, label] of MODES) mode.append(new Option(label, value));
  modeRow.append(modeLabel, mode);
  window.createSelect(mode).classList.add("audio-control");
  modeLabel.htmlFor = `${mode.id}-button`;
  mode.addEventListener("change", async () => {
    try { render(await request("POST", "/mode", { mode: mode.value })); }
    catch (err) { status.textContent = err.message; }
  });

  const installRow = el("div", "setting-row device-detail");
  const status = el("p", "settings-hint");
  status.setAttribute("role", "status");
  const commits = el("ul", "updates-commits");
  const actions = el("div", "updates-actions");
  const check = button("Check now", async () => {
    busy = true;
    renderSettings();
    let failed = null;
    try { render(await request("POST", "/check")); }
    catch (err) { failed = err.message; }
    busy = false;
    renderSettings();
    // After renderSettings, which would otherwise replace the error with the old status (#946).
    if (failed) status.textContent = failed;
  });
  const install = button("Update now", () => void apply());
  const unskip = button("Stop skipping", async () => {
    try { render(await request("POST", "/skip", { id: null })); }
    catch (err) { status.textContent = err.message; }
  });
  actions.append(check, install, unskip);
  section.append(heading, modeRow, installRow, status, commits, actions);

  const RELEASE_LABELS = {
    "linux-x64-headless": "Linux release (headless)",
    "macos-arm64-headless": "macOS release (headless, Apple silicon)",
    "macos-x64-headless": "macOS release (headless, Intel)",
  };

  function describeInstall(install) {
    if (install.kind === "git") {
      const where = install.upstream ? ` · ${install.branch} → ${install.upstream}` : install.branch ? ` · ${install.branch}` : "";
      return `${install.version} · git checkout${install.commit ? ` @ ${install.commit}` : ""}${where}`;
    }
    if (install.kind === "standalone") return `${install.version} · ${RELEASE_LABELS[install.target] || "Windows release"}`;
    return `${install.version} · not a git checkout or a release; it cannot update itself`;
  }

  function describeStatus(v) {
    if (v.phase === "checking") return "Checking…";
    if (v.phase === "downloading") return `Downloading ${v.available?.label ?? "the update"}…${v.progress != null ? ` ${Math.round(v.progress * 100)}%` : ""}`;
    if (v.phase === "installing") return `Installing ${v.available?.label ?? "the update"}…`;
    if (v.phase === "restarting") return "Restarting Scribe…";
    const lines = [];
    if (v.error) lines.push(v.error);
    if (v.available) {
      lines.push(v.available.blocked ? `${v.available.label}: ${v.available.blocked}` : v.available.id === v.skipped ? `${v.available.label} (skipped)` : `${v.available.label} is available.${v.waitingForIdle ? " It installs once Scribe is idle." : ""}`);
    } else if (v.checkedAt && !v.error) {
      lines.push(`Up to date. Checked ${new Date(v.checkedAt).toLocaleString()}.`);
    }
    for (const note of v.notes) lines.push(note);
    return lines.join(" ");
  }

  function renderSettings() {
    if (!view) return;
    mode.value = view.mode;
    const unknown = view.install.kind === "unknown";
    mode.disabled = unknown;
    installRow.replaceChildren(el("span", null, "Installed"), el("span", null, describeInstall(view.install)));
    status.textContent = describeStatus(view);
    const list = view.available?.commits ?? [];
    commits.hidden = !list.length || view.phase !== "idle";
    commits.replaceChildren(...list.slice(0, 10).map((c) => {
      const item = el("li");
      item.append(el("code", null, c.sha), ` ${c.subject}`);
      return item;
    }), ...(list.length > 10 ? [el("li", null, `…and ${list.length - 10} more`)] : []));
    const working = busy || view.phase !== "idle";
    check.disabled = working || unknown;
    install.hidden = !view.available || !!view.available.blocked;
    install.disabled = working;
    unskip.hidden = !view.skipped || view.available?.id !== view.skipped;
  }

  /* ---------- the notice ---------- */

  const notice = el("div", "update-notice");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  const noticeText = el("div", "update-notice-text");
  const noticeTitle = el("strong");
  const noticeDetail = el("span");
  noticeText.append(noticeTitle, noticeDetail);
  const noticeActions = el("div", "update-notice-actions");
  const noticeUpdate = button("Update", () => void apply(), "update-notice-primary");
  const noticeSkip = button("Skip version", async () => {
    try { render(await request("POST", "/skip", { id: view.available.id })); }
    catch (err) { window.scribeShowNotice?.(err.message); }
  });
  const noticeDismiss = button("Dismiss", async () => {
    notice.hidden = true;
    try { render(await request("POST", "/dismiss", { id: view.available.id })); }
    catch { /* hidden here either way */ }
  });
  noticeActions.append(noticeUpdate, noticeSkip, noticeDismiss);
  notice.append(noticeText, noticeActions);
  document.body.append(notice);

  function renderNotice() {
    const a = view?.available;
    const working = view && (view.phase === "installing" || view.phase === "restarting");
    const offer = a && !a.blocked && view.mode !== "ignore" && a.id !== view.skipped && a.id !== view.dismissed;
    notice.hidden = !(offer || working);
    if (notice.hidden) return;
    noticeTitle.textContent = working ? describeStatus(view) : `Update available: ${a.label}`;
    noticeDetail.textContent = working ? "" : view.mode === "auto" ? "It installs once Scribe is idle." : "Scribe restarts to install it.";
    noticeActions.hidden = working;
    noticeUpdate.disabled = view.phase !== "idle";
  }

  async function apply() {
    try { render(await request("POST", "/apply")); }
    catch (err) { window.scribeShowNotice?.(err.message); }
  }

  function render(next) {
    view = next;
    if (view.phase === "restarting") restarting = true;
    renderSettings();
    renderNotice();
  }

  async function refresh() {
    try { render(await request("GET", "")); } catch { /* an older daemon has no updates */ }
  }

  window.scribeUpdates = {
    sections: [section],
    refresh,
    /** The board's socket got an update event. */
    event(msg) { render(msg.view); },
    /** The socket (re)connected. After an update restart, load the new build's UI. */
    connected() {
      if (restarting) {
        location.reload();
        return;
      }
      void refresh();
    },
  };
})();
