import { randomUUID } from "node:crypto";
import type { ApprovalOutcome, ApprovalPolicy, RiskClass } from "@rakazo/core";
import {
  activeApprovers,
  approvalExpiresAt,
  approverStanding,
  isApprovalExpired,
  resolveApprovalPolicy,
  resolveApprovers,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { ExtApproval, Prisma, PrismaClient } from "./client.js";
import { answerApprovalAskInTransaction } from "./events.js";
import { getAuditWriter, redactAuditText, redactAuditValue } from "./ext-audit.js";
import { getEmergencyStop } from "./ext-emergency-stop.js";

/**
 * Fork extension: approvals (EXT_APPROVALS), spec in docs/governance/approvals.md.
 * Persistence and the single decision path every surface uses (web card, Slack button,
 * Teams button, expiry). The space always comes from the stored request or the verified
 * decider, never from input.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type ApprovalRow = ExtApproval;
export type ApprovalVia = "web" | "slack" | "teams" | "system";

export async function loadApprovalPolicy(
  db: Db,
  input: { spaceId: string; botId: string },
): Promise<ApprovalPolicy> {
  const row = await db.extBotApprovalPolicy.findFirst({
    where: { botId: input.botId, spaceId: input.spaceId },
    select: { gatedClasses: true, approverUserIds: true },
  });
  return resolveApprovalPolicy(row);
}

export async function saveApprovalPolicy(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botId: string; actorId: string; patch: Partial<ApprovalPolicy> },
): Promise<ApprovalPolicy> {
  const current = await loadApprovalPolicy(tx, input);
  const next = { ...current, ...input.patch };
  await tx.extBotApprovalPolicy.upsert({
    where: { botId: input.botId },
    create: {
      botId: input.botId,
      spaceId: input.spaceId,
      gatedClasses: next.gatedClasses,
      approverUserIds: next.approverUserIds,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    },
    update: {
      gatedClasses: next.gatedClasses,
      approverUserIds: next.approverUserIds,
      updatedBy: input.actorId,
    },
  });
  return next;
}

export interface SpaceRoster {
  members: Array<{ userId: string; name: string; owner: boolean }>;
}

export async function loadSpaceRoster(db: Db, spaceId: string): Promise<SpaceRoster> {
  const rows = await db.spaceMember.findMany({
    where: { spaceId },
    select: { userId: true, role: true, member: { select: { user: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return {
    members: rows.map((row) => ({
      userId: row.userId,
      name: row.member.user.name,
      owner: isOwnerRole(row.role),
    })),
  };
}

async function memberIds(db: Db, spaceId: string): Promise<string[]> {
  const rows = await db.spaceMember.findMany({ where: { spaceId }, select: { userId: true } });
  return rows.map((row) => row.userId);
}

export interface ApprovalRequestInput {
  spaceId: string;
  botId: string;
  runId: string;
  threadId: string;
  effectId: string;
  toolName: string;
  riskClass: RiskClass;
  callHash: string;
  args: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  /** Secret values known to the run; scrubbed from what is stored and audited. */
  secrets: string[];
  now?: Date;
}

/**
 * Record a request and its `approval.request` audit event in one transaction (fail closed:
 * without the audit record there is no request, and the caller must not run the tool).
 * A request for an effect that already has one returns the existing row.
 */
export async function createApprovalRequest(
  prisma: PrismaClient,
  input: ApprovalRequestInput,
): Promise<ApprovalRow> {
  const now = input.now ?? new Date();
  const args = redactAuditValue(input.args, { secrets: input.secrets }) as Prisma.InputJsonValue;
  const reason = redactAuditText(input.reason, input.secrets).trim().slice(0, 2_000);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.extApproval.findUnique({ where: { effectId: input.effectId } });
    if (existing) return existing;
    const policy = await loadApprovalPolicy(tx, input);
    const roster = await loadSpaceRoster(tx, input.spaceId);
    const approverIds = resolveApprovers({
      configured: policy.approverUserIds,
      owners: roster.members.filter((member) => member.owner).map((member) => member.userId),
      requesterId: input.requestedBy,
      members: roster.members.map((member) => member.userId),
    });
    const row = await tx.extApproval.create({
      data: {
        id: randomUUID(),
        spaceId: input.spaceId,
        botId: input.botId,
        runId: input.runId,
        threadId: input.threadId,
        effectId: input.effectId,
        toolName: input.toolName,
        riskClass: input.riskClass,
        callHash: input.callHash,
        args,
        reason,
        requestedBy: input.requestedBy,
        approverIds,
        status: "pending",
        createdAt: now,
        expiresAt: approvalExpiresAt(now),
      },
    });
    await getAuditWriter()?.recordInTransaction(tx, {
      spaceId: input.spaceId,
      botId: input.botId,
      runId: input.runId,
      actor: { type: "bot", id: input.botId },
      kind: "approval.request",
      summary: `Approval requested for ${input.toolName}`,
      detail: {
        approvalId: row.id,
        tool: input.toolName,
        riskClass: input.riskClass,
        args,
        reason,
        approvers: approverIds,
        expiresAt: row.expiresAt.toISOString(),
      },
      secrets: input.secrets,
      at: now,
    });
    return row;
  });
}

export type ApprovalDecider = { type: "human"; userId: string } | { type: "system" };

export interface DecideApprovalInput {
  /** Locate by approval id (chat buttons) or by the gated effect (web card). */
  approvalId?: string;
  effectId?: string;
  /** The verified decider's space when the caller has one; another space's request is not found. */
  spaceId?: string;
  decider: ApprovalDecider;
  /** What the person chose; the system always denies. */
  answer: "allow" | "deny";
  via: ApprovalVia;
  interactionId?: string;
  now?: Date;
  /** Why the system decided, for the record (expiry and approver loss are derived here). */
  note?: string;
}

export type DecideApprovalResult =
  | { status: "decided"; outcome: ApprovalOutcome; approval: ApprovalRow; resumed: boolean }
  | { status: "already_decided"; approval: ApprovalRow }
  | { status: "not_allowed"; reason: "not_listed" | "left"; approval: ApprovalRow }
  | { status: "not_found" };

/**
 * The one decision path. Under a row lock: a pending request is decided exactly once
 * (a second decision is "already decided"); only a listed approver who is still a member
 * may decide; an expired request, one with no approver left, or one whose bot is stopped
 * resolves as a deny whatever was clicked. The approval row, the `approval.decision` audit
 * event and the run's resume (the same answer the web card gives) commit together, so a
 * failed audit write leaves everything pending and nothing runs.
 */
export async function decideApproval(
  prisma: PrismaClient,
  input: DecideApprovalInput,
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<DecideApprovalResult> {
  const now = input.now ?? new Date();
  const located = input.approvalId
    ? await prisma.extApproval.findUnique({ where: { id: input.approvalId } })
    : input.effectId
      ? await prisma.extApproval.findUnique({ where: { effectId: input.effectId } })
      : null;
  if (!located || (input.spaceId && located.spaceId !== input.spaceId)) {
    return { status: "not_found" };
  }
  // Read outside the transaction (it may hit the database once); acting on it is checked
  // again at execution by the run's own guard.
  const stopped = Boolean(
    await getEmergencyStop()?.check({ spaceId: located.spaceId, botId: located.botId }),
  );
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ext_approvals WHERE id = ${located.id} FOR UPDATE`;
    const row = await tx.extApproval.findUniqueOrThrow({ where: { id: located.id } });
    if (row.status !== "pending") return { status: "already_decided" as const, approval: row };
    const members = await memberIds(tx, row.spaceId);
    if (input.decider.type === "human") {
      const standing = approverStanding({
        approvers: row.approverIds,
        members,
        userId: input.decider.userId,
      });
      if (standing !== "approver") {
        return { status: "not_allowed" as const, reason: standing, approval: row };
      }
    }
    let outcome: ApprovalOutcome = input.decider.type === "system" ? "deny" : input.answer;
    let note = input.note ?? null;
    if (isApprovalExpired(row.expiresAt, now)) {
      outcome = "expired";
      note = null;
    } else if (activeApprovers(row.approverIds, members).length === 0) {
      outcome = "invalid";
      note = "No approver is left in the space";
    } else if (stopped) {
      outcome = "invalid";
      note = "The bot is stopped";
    } else if (input.decider.type === "system" && note) {
      outcome = "invalid";
    }
    const answer = await answerApprovalAskInTransaction(tx, {
      spaceId: row.spaceId,
      threadId: row.threadId,
      runId: row.runId,
      effectId: row.effectId,
      answeredByUserId: input.decider.type === "human" ? input.decider.userId : row.requestedBy,
      answer: outcome === "allow" ? "allow" : "deny",
    });
    if (!answer && outcome === "allow") {
      // The run no longer waits on this card (cancelled or stopped): nothing may run.
      outcome = "invalid";
      note = "The run no longer waits for this approval";
    }
    const decided = await tx.extApproval.update({
      where: { id: row.id },
      data: {
        status: outcome,
        decidedAt: now,
        decidedBy: input.decider.type === "human" ? input.decider.userId : null,
        decidedVia: input.decider.type === "human" ? input.via : "system",
        interactionId: input.interactionId ?? null,
        decisionNote: note,
      },
    });
    await getAuditWriter()?.recordInTransaction(tx, {
      spaceId: row.spaceId,
      botId: row.botId,
      runId: row.runId,
      actor:
        input.decider.type === "human"
          ? { type: "human", id: input.decider.userId }
          : { type: "system", id: "approvals" },
      kind: "approval.decision",
      summary: `Approval ${outcome} for ${row.toolName}`,
      detail: {
        approvalId: row.id,
        tool: row.toolName,
        riskClass: row.riskClass,
        decision: outcome,
        via: decided.decidedVia,
        ...(note ? { note } : {}),
        ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      },
      at: now,
    });
    return { status: "decided" as const, outcome, approval: decided, answer };
  });
  if (result.status === "not_allowed") {
    getLogger().warn("approval decision refused", {
      "approval.id": located.id,
      "space.id": located.spaceId,
      "user.id": input.decider.type === "human" ? input.decider.userId : undefined,
      reason: result.reason,
      via: input.via,
    });
    return result;
  }
  if (result.status === "already_decided") return result;
  if (result.answer && notify) {
    await notify(result.answer.threadId, result.answer.seq).catch(() => undefined);
  }
  return {
    status: "decided",
    outcome: result.outcome,
    approval: result.approval,
    resumed: Boolean(result.answer),
  };
}

/**
 * Requests that must end without a person: past their deadline, or with every approver
 * gone from the space. Bounded per sweep; the next sweep takes the rest.
 */
export async function findApprovalsToClose(
  prisma: PrismaClient,
  now: Date,
  limit = 100,
): Promise<Array<{ id: string; reason: "expired" | "no_approver" }>> {
  const expired = await prisma.extApproval.findMany({
    where: { status: "pending", expiresAt: { lte: now } },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
  const pending = await prisma.extApproval.findMany({
    where: { status: "pending", expiresAt: { gt: now } },
    select: { id: true, spaceId: true, approverIds: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const membersBySpace = new Map<string, string[]>();
  const orphaned: Array<{ id: string; reason: "no_approver" }> = [];
  for (const row of pending) {
    let members = membersBySpace.get(row.spaceId);
    if (!members) {
      members = await memberIds(prisma, row.spaceId);
      membersBySpace.set(row.spaceId, members);
    }
    if (activeApprovers(row.approverIds, members).length === 0) {
      orphaned.push({ id: row.id, reason: "no_approver" });
    }
  }
  return [...expired.map((row) => ({ id: row.id, reason: "expired" as const })), ...orphaned];
}

/**
 * Execution-time check for a call resuming after approval. Null when the call may run; a
 * refusal message otherwise. A gated effect without an approved request, or whose hash
 * does not match the call about to run, never executes.
 */
export async function checkApprovedCall(
  db: Db,
  input: { effectId: string; callHash: string },
): Promise<{ gated: boolean; refusal: string | null }> {
  const row = await db.extApproval.findUnique({
    where: { effectId: input.effectId },
    select: { status: true, callHash: true },
  });
  if (!row) return { gated: false, refusal: null };
  if (row.status !== "allow") {
    return { gated: true, refusal: "This action was not approved. Do not retry it." };
  }
  if (row.callHash !== input.callHash) {
    return {
      gated: true,
      refusal: "The approval covers a different call. Ask for approval of this exact call.",
    };
  }
  return { gated: true, refusal: null };
}

function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}
