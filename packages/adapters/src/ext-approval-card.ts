import type { MessagingCard } from "@rakazo/adapter-kit";
import type { ApprovalOutcome, RiskClass } from "@rakazo/core";
import { approvalHashLabel, canonicalArgsText } from "@rakazo/core";
import { redactAuditText, redactAuditValue } from "@rakazo/db";

/** Button action ids of an approval card; the value is the approval id, nothing more. */
export const APPROVAL_ALLOW_ACTION = "ext_approval_allow";
export const APPROVAL_DENY_ACTION = "ext_approval_deny";
export const APPROVAL_ACTIONS = [APPROVAL_ALLOW_ACTION, APPROVAL_DENY_ACTION];

/** Shown when a chat card cannot carry the whole call; its Approve button goes with it. */
const HIDDEN_NOTICE = "{hidden} characters hidden. Open the web app to see the full call.";

const RISK_LABELS: Record<RiskClass, string> = {
  read: "Read",
  "write-internal": "Internal change",
  "write-external": "External action",
};

export interface ApprovalCardInput {
  approvalId: string;
  botName: string;
  toolName: string;
  riskClass: RiskClass;
  args: unknown;
  reason: string;
  /** Hash of the tool name and canonical arguments; its first 8 characters label the call. */
  callHash: string;
  expiresAt: Date;
  /** Secret values known to the run; scrubbed in addition to secret-named keys. */
  secrets?: string[];
}

/**
 * The card a gated call posts to chat: the whole call (every argument, keys sorted as the
 * hash sorts them, redacted) and the bot's reason. If the platform cannot show all of it,
 * the card says how much is hidden and offers Deny only.
 */
export function buildApprovalRequestCard(input: ApprovalCardInput): MessagingCard {
  return {
    title: `${input.botName} needs approval`,
    blocks: details(input),
    actions: [
      { id: APPROVAL_ALLOW_ACTION, label: "Approve", value: input.approvalId, style: "primary" },
      { id: APPROVAL_DENY_ACTION, label: "Deny", value: input.approvalId, style: "danger" },
    ],
    overflow: { notice: HIDDEN_NOTICE, dropActions: [APPROVAL_ALLOW_ACTION] },
  };
}

/** The web approval card's detail: the reason, the call label and every argument, uncut. */
export function approvalWebDetail(
  input: Pick<ApprovalCardInput, "reason" | "callHash" | "args" | "secrets">,
): string {
  const reason = redactAuditText(input.reason ?? "", input.secrets ?? []).trim();
  return [
    ...(reason ? [`Reason: ${reason}`] : []),
    `Call ${approvalHashLabel(input.callHash)}`,
    argsText(input),
  ].join("\n\n");
}

function argsText(input: Pick<ApprovalCardInput, "args" | "secrets">): string {
  return canonicalArgsText(
    redactAuditValue(input.args ?? {}, { secrets: input.secrets ?? [], full: true }),
  );
}

/** The same card once decided: the outcome instead of the buttons. */
export function buildApprovalDecidedCard(
  input: ApprovalCardInput,
  decision: { outcome: ApprovalOutcome; byName?: string },
): MessagingCard {
  const blocks = details(input).filter((block) => !block.text.startsWith("Expires "));
  blocks.push({ kind: "muted", text: outcomeLine(decision) });
  return { title: `${input.botName} needs approval`, blocks };
}

export function outcomeLine(decision: { outcome: ApprovalOutcome; byName?: string }): string {
  const by = decision.byName?.trim() ? ` by ${decision.byName.trim()}` : "";
  switch (decision.outcome) {
    case "allow":
      return `Approved${by}`;
    case "deny":
      return `Denied${by}`;
    case "expired":
      return "Expired without a decision";
    default:
      return "No longer valid";
  }
}

function details(input: ApprovalCardInput): MessagingCard["blocks"] {
  const secrets = input.secrets ?? [];
  const blocks: MessagingCard["blocks"] = [
    { kind: "text", text: `Action: ${input.toolName} (${RISK_LABELS[input.riskClass]})` },
    { kind: "muted", text: `Call ${approvalHashLabel(input.callHash)}` },
  ];
  const reason = redactAuditText(input.reason ?? "", secrets).trim();
  if (reason) blocks.push({ kind: "text", text: `Reason: ${reason}` });
  blocks.push({ kind: "code", text: argsText(input) });
  const hhmm = input.expiresAt.toISOString().slice(11, 16);
  blocks.push({ kind: "muted", text: `Expires ${hhmm} UTC` });
  return blocks;
}
