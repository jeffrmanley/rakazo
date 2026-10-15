import type { MessagingCard } from "@rakazo/adapter-kit";
import type { ApprovalOutcome, RiskClass } from "@rakazo/core";
import { redactAuditText, redactAuditValue } from "@rakazo/db";

/** Button action ids of an approval card; the value is the approval id, nothing more. */
export const APPROVAL_ALLOW_ACTION = "ext_approval_allow";
export const APPROVAL_DENY_ACTION = "ext_approval_deny";
export const APPROVAL_ACTIONS = [APPROVAL_ALLOW_ACTION, APPROVAL_DENY_ACTION];

const MAX_ARGS_CHARS = 2_000;
const MAX_REASON_CHARS = 500;

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
  expiresAt: Date;
  /** Secret values known to the run; scrubbed in addition to secret-named keys. */
  secrets?: string[];
}

/** The card a gated call posts to chat. Arguments and reason go through the audit redaction. */
export function buildApprovalRequestCard(input: ApprovalCardInput): MessagingCard {
  return {
    title: `${input.botName} needs approval`,
    blocks: details(input),
    actions: [
      { id: APPROVAL_ALLOW_ACTION, label: "Approve", value: input.approvalId, style: "primary" },
      { id: APPROVAL_DENY_ACTION, label: "Deny", value: input.approvalId, style: "danger" },
    ],
  };
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
  ];
  const reason = redactAuditText(input.reason ?? "", secrets).trim();
  if (reason) blocks.push({ kind: "text", text: `Reason: ${clip(reason, MAX_REASON_CHARS)}` });
  const args = JSON.stringify(redactAuditValue(input.args ?? {}, { secrets }), null, 2);
  blocks.push({ kind: "code", text: clip(args, MAX_ARGS_CHARS) });
  const hhmm = input.expiresAt.toISOString().slice(11, 16);
  blocks.push({ kind: "muted", text: `Expires ${hhmm} UTC` });
  return blocks;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
