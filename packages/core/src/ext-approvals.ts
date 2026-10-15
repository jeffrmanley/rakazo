import { connectorToolRequiresApproval } from "./action-approval.js";
import type { Parsed } from "./ext-budget.js";

/**
 * Fork extension: human approval of risky tool calls (EXT_APPROVALS), spec in
 * docs/governance/approvals.md. Pure rules shared by the executor, the API and the web app.
 */

export const RISK_CLASSES = ["read", "write-internal", "write-external"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_CLASSES as readonly string[]).includes(value);
}

/**
 * Built-in tools by risk class. Read: no side effect. Internal: a side effect inside the
 * deployment (the bot's own computer, memory, files, schedule and space). External: the
 * upstream consequential tools that act outside the deployment, and tools that make another
 * actor act (another bot, a cloud agent, a tool server the model adds). Anything not listed,
 * built-in or connector, falls through to the default-deny rule in toolRiskClass.
 */
export const EXPLICIT_RISK_CLASSES: Readonly<Record<RiskClass, readonly string[]>> = {
  read: [
    "ask_user",
    "board_tickets",
    "browser_snapshot",
    "cloud_agent_status",
    "computer_observe",
    "end_call",
    "list_files",
    "list_secrets",
    "read_file",
    "read_history",
    "recall_memory",
    "request_takeover",
    "run_subagent",
    "schedule_list",
    "scratchpad_list",
    "search_history",
    "skill_read",
    "task_catalog",
    "ticket_get",
    "web_fetch",
    "web_search",
  ],
  "write-internal": [
    "archive_bot",
    "attach_file",
    "browser_act",
    "browser_navigate",
    "computer_act",
    "create_space",
    "delete_bot",
    "forget_memory",
    "forget_secret",
    "launch_app",
    "message_user",
    "open_path",
    "remember",
    "render_plot",
    "request_secret",
    "save_memory",
    "save_shared_memory",
    "schedule_cancel",
    "schedule_create",
    "scratchpad_add",
    "scratchpad_complete",
    "scratchpad_remove",
    "scratchpad_update",
    "secret_request",
    "shell",
    "skill_create",
    "skill_delete",
    "skill_update",
    "ticket_comment",
    "ticket_create",
    "ticket_update",
    "update_bot",
    "write_file",
  ],
  "write-external": [
    "add_mcp_server",
    "cloud_agent_cancel",
    "cloud_agent_launch",
    "cloud_agent_reply",
    "connect_agent",
    "destination.write",
    "handoff_to_bot",
    "message_agent",
    "message_bot",
    "respond_agent_connection",
    "spawn_bot",
  ],
};

const CLASS_OF_TOOL = new Map<string, RiskClass>(
  RISK_CLASSES.flatMap((riskClass) =>
    EXPLICIT_RISK_CLASSES[riskClass].map((tool) => [tool, riskClass] as const),
  ),
);

/**
 * Risk class of one call. Connector tools follow the upstream consequential rule (a declared
 * write or a mutating or unknown name needs approval there, and counts as external here).
 * Default deny: a tool nobody classified is write-external.
 */
export function toolRiskClass(input: {
  toolName: string;
  viaConnector: boolean;
  readOnly?: boolean;
  /** The tool comes from a tool server the model itself added: no name is trusted. */
  modelAdded?: boolean;
}): RiskClass {
  if (input.viaConnector) {
    if (input.modelAdded) return "write-external";
    return connectorToolRequiresApproval(input.toolName, input.readOnly)
      ? "write-external"
      : "read";
  }
  return CLASS_OF_TOOL.get(input.toolName) ?? "write-external";
}

/**
 * Conversation tools never wait on an approval: asking the person, ending a call, secure
 * secret entry (its own card) and asking the person to take over the computer.
 */
const APPROVAL_EXEMPT_TOOLS = new Set([
  "ask_user",
  "end_call",
  "request_secret",
  "request_takeover",
]);

export function isApprovalExempt(toolName: string): boolean {
  return APPROVAL_EXEMPT_TOOLS.has(toolName);
}

/**
 * The arguments as approvers see them: every key, sorted at every depth (the order the
 * call hash uses), two-space indented. Keys the model put last cannot hide at the end.
 */
export function canonicalArgsText(args: unknown): string {
  return JSON.stringify(sortKeys(args), null, 2) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The short form of a call hash shown on every card, so approvers can match them. */
export function approvalHashLabel(callHash: string): string {
  return callHash.slice(0, 8);
}

export const DEFAULT_GATED_CLASSES: readonly RiskClass[] = ["write-external"];
export const MAX_APPROVERS = 100;

export interface ApprovalPolicy {
  /** Classes whose calls wait for a person; an empty list never asks. */
  gatedClasses: RiskClass[];
  /** Configured approvers; empty means the space owners plus the user who started the run. */
  approverUserIds: string[];
}

export function resolveApprovalPolicy(
  stored: { gatedClasses: readonly string[]; approverUserIds: readonly string[] } | null,
): ApprovalPolicy {
  if (!stored) return { gatedClasses: [...DEFAULT_GATED_CLASSES], approverUserIds: [] };
  return {
    gatedClasses: RISK_CLASSES.filter((riskClass) => stored.gatedClasses.includes(riskClass)),
    approverUserIds: uniqueSorted(stored.approverUserIds),
  };
}

export function approvalRequired(policy: ApprovalPolicy, riskClass: RiskClass): boolean {
  return policy.gatedClasses.includes(riskClass);
}

/** Known fields only; anything else (a spaceId included) is ignored. */
export function parseApprovalPolicyPatch(
  body: Record<string, unknown>,
): Parsed<Partial<ApprovalPolicy>> {
  const patch: Partial<ApprovalPolicy> = {};
  if (body.gatedClasses !== undefined) {
    if (!Array.isArray(body.gatedClasses)) {
      return { ok: false, error: "gatedClasses must be a list" };
    }
    if (!body.gatedClasses.every(isRiskClass)) return { ok: false, error: "Unknown risk class" };
    const chosen = body.gatedClasses as RiskClass[];
    patch.gatedClasses = RISK_CLASSES.filter((riskClass) => chosen.includes(riskClass));
  }
  if (body.approverUserIds !== undefined) {
    const ids = body.approverUserIds;
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
    ) {
      return { ok: false, error: "approverUserIds must be a list of user ids" };
    }
    if (ids.length > MAX_APPROVERS) {
      return { ok: false, error: `At most ${MAX_APPROVERS} approvers` };
    }
    patch.approverUserIds = uniqueSorted(ids as string[]);
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change" };
  return { ok: true, value: patch };
}

/** A pending approval lapses (and counts as a deny) thirty minutes after it was requested. */
export const APPROVAL_TTL_MS = 30 * 60_000;

export function approvalExpiresAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + APPROVAL_TTL_MS);
}

export function isApprovalExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * Who may decide a request: the configured list, else the space owners plus the user who
 * started the run, and in either case only people who are members of the space now.
 */
export function resolveApprovers(input: {
  configured: readonly string[];
  owners: readonly string[];
  requesterId: string;
  members: readonly string[];
}): string[] {
  const candidates =
    input.configured.length > 0 ? input.configured : [...input.owners, input.requesterId];
  const members = new Set(input.members);
  return uniqueSorted(candidates.filter((id) => members.has(id)));
}

export type ApproverStanding = "approver" | "not_listed" | "left" | "removed";

/**
 * May this user decide? Only someone on the request's approver list (fixed when it was
 * made) who is still a member of the space and still eligible under the bot's current
 * policy (`eligible`, from resolveApprovers now). Leaving and rejoining restores nothing the
 * current policy does not grant.
 */
export function approverStanding(input: {
  approvers: readonly string[];
  members: readonly string[];
  eligible: readonly string[];
  userId: string;
}): ApproverStanding {
  if (!input.approvers.includes(input.userId)) return "not_listed";
  if (!input.members.includes(input.userId)) return "left";
  return input.eligible.includes(input.userId) ? "approver" : "removed";
}

/** The request's approvers who may still decide; empty means nobody can any more. */
export function activeApprovers(
  approvers: readonly string[],
  eligible: readonly string[],
): string[] {
  const current = new Set(eligible);
  return approvers.filter((id) => current.has(id));
}

/** How a request ended, as recorded on the approval and in `approval.decision`. */
export const APPROVAL_OUTCOMES = ["allow", "deny", "expired", "invalid"] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
