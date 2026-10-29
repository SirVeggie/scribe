import { isPlainRecord, type Thread } from "./types.js";

/** Provider observations, never a grant or a replacement for the user's settings. */
export type EffectivePermissions = {
  provider: "codex";
  requestedSandbox: string;
  sandbox: string;
  requestedApproval: string;
  approval: string;
  reviewer: string;
  boardActions: "unchecked" | "available" | "missing";
  reports: "unchecked" | "available" | "missing";
};

export function codexPermissions(result: Record<string, unknown>, requested: Record<string, unknown>): EffectivePermissions {
  const policy = isPlainRecord(result.sandbox) ? result.sandbox : isPlainRecord(result.sandboxPolicy) ? result.sandboxPolicy : {};
  const raw = typeof result.sandbox === "string" ? result.sandbox : policy.type;
  const modes: Record<string, string> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access", externalSandbox: "external-sandbox" };
  return {
    provider: "codex",
    requestedSandbox: String(requested.sandbox),
    sandbox: typeof raw === "string" ? modes[raw] ?? raw : "unknown",
    requestedApproval: String(requested.approvalPolicy),
    approval: typeof result.approvalPolicy === "string" ? result.approvalPolicy : "unknown",
    reviewer: typeof result.approvalsReviewer === "string" ? result.approvalsReviewer : "unknown",
    boardActions: "unchecked", reports: "unchecked",
  };
}

/** Inventory checks are read-only. Tool presence does not prove a future mutation will be approved. */
export function scribeToolAvailability(tools: Record<string, unknown>): Pick<EffectivePermissions, "boardActions" | "reports"> {
  const names = new Set(Object.entries(tools).flatMap(([key, tool]) => [key, ...(isPlainRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])]));
  const has = (name: string) => [...names].some((key) => key === name || key === `mcp__scribe__${name}`);
  return { boardActions: has("page_action") ? "available" : "missing", reports: has("page_show") ? "available" : "missing" };
}

export function permissionBoundaryProblem(policy: EffectivePermissions): string | null {
  const rank: Record<string, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
  if (policy.sandbox === "external-sandbox" || (rank[policy.sandbox] !== undefined && rank[policy.requestedSandbox] !== undefined && rank[policy.sandbox] > rank[policy.requestedSandbox])) {
    return "Launch stopped: Codex returned filesystem permissions broader than requested. Check the provider configuration before retrying.";
  }
  return null;
}

export type WorkerToolRequirements = { boardActions?: boolean; reports?: boolean };

export function workerPermissionProblem(thread: Pick<Thread, "mode" | "scope">, policy: EffectivePermissions, required: WorkerToolRequirements): string | null {
  if ((required.boardActions || required.reports) && thread.scope.kind === "workspace") return "Worker cannot report or hand in its card: App scope None removes Scribe tools. Choose the board's page scope.";
  if (thread.mode === "code" && policy.sandbox === "read-only") return "Code worker launch stopped: Codex returned read-only filesystem access. File edits and commits cannot run. Check the Codex sandbox setup before retrying; on Windows, select a supported Windows sandbox implementation.";
  if (policy.sandbox === "unknown" || policy.approval === "unknown") return "Worker launch stopped: Codex did not report its effective filesystem or approval policy. Update or check the provider before retrying.";
  if (policy.approval !== policy.requestedApproval) return "Worker launch stopped: Codex returned an approval policy different from the requested policy. Check the provider configuration before retrying.";
  if (required.boardActions && policy.boardActions !== "available") return "Worker launch stopped: Codex has no verified Scribe page_action tool for board hand-in. Check the Scribe MCP connection before retrying.";
  if (required.reports && policy.reports !== "available") return "Worker launch stopped: Codex has no verified Scribe page_show tool for saving reports. Check the Scribe MCP connection before retrying.";
  return null;
}

export function permissionSummary(policy: EffectivePermissions): string {
  return `Codex permissions: filesystem ${policy.sandbox} (requested ${policy.requestedSandbox}); approvals ${policy.approval} (requested ${policy.requestedApproval}); reviewer ${policy.reviewer}. Board actions: ${policy.boardActions}; report pages: ${policy.reports}. Tool availability is checked separately from filesystem access; provider approval still applies to page mutations.`;
}
