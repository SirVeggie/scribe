import type { WebSocket } from "ws";

export const EDIT_GRACE_MS = 5000;

export type Viewer = {
  socket: WebSocket;
  selectedId: string | null;
  lastInteractedAt: number;
  lastEditAt: number;
  /** The last key, click or scroll in the window (throttled), for auto updates' idle check (#942). */
  activeAt: number;
  connectedAt: number;
  /** A desktop window hidden in the tray: connected, but nobody is looking at it. */
  hidden: boolean;
};

export class ViewerHub {
  private viewers = new Map<WebSocket, Viewer>();

  add(socket: WebSocket): Viewer {
    const viewer: Viewer = {
      socket,
      selectedId: null,
      lastInteractedAt: 0,
      lastEditAt: 0,
      activeAt: 0,
      connectedAt: Date.now(),
      hidden: false,
    };
    this.viewers.set(socket, viewer);
    return viewer;
  }

  remove(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  update(
    socket: WebSocket,
    patch: { selectedId?: string | null; lastInteractedAt?: unknown; lastEditAt?: unknown; activeAt?: unknown; hidden?: unknown }
  ): void {
    const viewer = this.viewers.get(socket);
    if (!viewer) {
      return;
    }
    if (patch.selectedId === null || typeof patch.selectedId === "string") {
      viewer.selectedId = patch.selectedId;
    }
    if (typeof patch.lastInteractedAt === "number" && Number.isFinite(patch.lastInteractedAt)) {
      viewer.lastInteractedAt = Math.max(viewer.lastInteractedAt, patch.lastInteractedAt);
    }
    if (typeof patch.lastEditAt === "number" && Number.isFinite(patch.lastEditAt)) {
      viewer.lastEditAt = Math.max(viewer.lastEditAt, patch.lastEditAt);
    }
    if (typeof patch.activeAt === "number" && Number.isFinite(patch.activeAt)) {
      viewer.activeAt = Math.min(Date.now(), Math.max(viewer.activeAt, patch.activeAt));
    }
    if (typeof patch.hidden === "boolean") {
      viewer.hidden = patch.hidden;
    }
  }

  /** The latest input in any window, hidden ones too; 0 when there has been none. */
  lastActivity(): number {
    let latest = 0;
    for (const viewer of this.viewers.values()) latest = Math.max(latest, viewer.activeAt, viewer.lastInteractedAt, viewer.lastEditAt);
    return Math.min(latest, Date.now());
  }

  /** Viewers someone can see. With none, agents open the board. */
  count(): number {
    return this.visible().length;
  }

  private visible(): Viewer[] {
    return [...this.viewers.values()].filter((viewer) => !viewer.hidden);
  }

  /**
   * Who should switch to `tabId` after an activating page update.
   * `already-visible` = some window is already on that tab; nobody switches.
   * `null` = blocked (recent edit) or no viewers.
   */
  focusTarget(tabId: string): Viewer | "already-visible" | null {
    const list = this.visible();
    if (list.length === 0) {
      return null;
    }
    if (list.some((viewer) => viewer.selectedId === tabId)) {
      return "already-visible";
    }
    const target = pickLatest(list);
    if (target.lastEditAt > 0 && Date.now() - target.lastEditAt < EDIT_GRACE_MS) {
      return null;
    }
    return target;
  }
}

function pickLatest(list: Viewer[]): Viewer {
  return list.reduce((best, viewer) => {
    const a = viewer.lastInteractedAt || viewer.connectedAt;
    const b = best.lastInteractedAt || best.connectedAt;
    return a >= b ? viewer : best;
  });
}
