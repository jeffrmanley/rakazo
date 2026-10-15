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
  const row = await db.extBotApprovalPolicy.findUnique({
    where: { spaceId_botId: { spaceId: input.spaceId, botId: input.botId } },
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
    where: { spaceId_botId: { spaceId: input.spaceId, botId: input.botId } },
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

/** Every member of a space, read page by page (no cap). */
export async function loadSpaceRoster(
  db: Db,
  spaceId: string,
  options: { batchSize?: number } = {},
): Promise<SpaceRoster> {
  const batchSize = options.batchSize ?? 500;
  const members: SpaceRoster["members"] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.spaceMember.findMany({
      where: { spaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        userId: true,
        role: true,
        member: { select: { user: { select: { name: true } } } },
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    for (const row of rows) {
      members.push({
        userId: row.userId,
        name: row.member.user.name,
        owner: isOwnerRole(row.role),
      });
    }
    if (rows.length < batchSize) break;
    cursor = rows.at(-1)!.id;
  }
  return { members };
}

/**
 * Who may approve this bot's requests right now: the bot's configured approvers, else the
 * space owners plus the requester, and only current members. Queried by user id, so the
 * size of the space does not matter.
 */
export async function eligibleApprovers(
  db: Db,
  input: { spaceId: string; botId: string; requestedBy: string },
): Promise<string[]> {
  const policy = await loadApprovalPolicy(db, input);
  const owners = (
    await db.spaceMember.findMany({
      where: { spaceId: input.spaceId, role: { contains: "owner" } },
      select: { userId: true, role: true },
    })
  )
    .filter((row) => isOwnerRole(row.role))
    .map((row) => row.userId);
  const candidates = [...new Set([...policy.approverUserIds, ...owners, input.requestedBy])];
  const members = (
    await db.spaceMember.findMany({
      where: { spaceId: input.spaceId, userId: { in: candidates } },
      select: { userId: true },
    })
  ).map((row) => row.userId);
  return resolveApprovers({
    configured: policy.approverUserIds,
    owners,
    requesterId: input.requestedBy,
    members,
  });
}

async function isMember(db: Db, spaceId: string, userId: string): Promise<boolean> {
  return Boolean(
    await db.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      select: { id: true },
    }),
  );
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
  // Stored in full (redacted, never cut): approvers must see the whole call.
  const args = redactAuditValue(input.args, {
    secrets: input.secrets,
    full: true,
  }) as Prisma.InputJsonValue;
  const reason = redactAuditText(input.reason, input.secrets).trim();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.extApproval.findUnique({ where: { effectId: input.effectId } });
    if (existing) return existing;
    const approverIds = await eligibleApprovers(tx, input);
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
  | { status: "not_allowed"; reason: "not_listed" | "left" | "removed"; approval: ApprovalRow }
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
  // A fresh read, not the one second cache: a stop written by another process a moment ago
  // must keep this approval from being granted. The run's guard checks again at execution.
  const stopped = await isStoppedNow({ spaceId: located.spaceId, botId: located.botId });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ext_approvals WHERE id = ${located.id} FOR UPDATE`;
    const row = await tx.extApproval.findUniqueOrThrow({ where: { id: located.id } });
    if (row.status !== "pending") return { status: "already_decided" as const, approval: row };
    const eligible = await eligibleApprovers(tx, row);
    if (input.decider.type === "human") {
      const userId = input.decider.userId;
      const standing = approverStanding({
        approvers: row.approverIds,
        members: (await isMember(tx, row.spaceId, userId)) ? [userId] : [],
        eligible,
        userId,
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
    } else if (activeApprovers(row.approverIds, eligible).length === 0) {
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
 * Emergency stop state read from the database, bypassing the reader's one second cache
 * (approvals act on "running", which the cache alone may not vouch for).
 */
export async function isStoppedNow(target: { spaceId: string; botId: string }): Promise<boolean> {
  const reader = getEmergencyStop();
  if (!reader) return false;
  reader.invalidate(target.spaceId);
  return Boolean(await reader.check(target));
}

/** Run states after which nothing can resume on an approval. */
const ENDED_RUN_STATUSES = ["completed", "failed", "cancelled"];

export type CloseReason = "expired" | "no_approver" | "run_ended";

export const CLOSE_NOTES: Record<Exclude<CloseReason, "expired">, string> = {
  no_approver: "No approver is left in the space",
  run_ended: "The run ended before a decision",
};

/**
 * Requests that must end without a person: past their deadline, with nobody on their list
 * still eligible (left the space or taken off the bot's approvers), or whose run already
 * ended (cancelled by a stop, for example). Reads every pending request page by page.
 */
export async function findApprovalsToClose(
  prisma: PrismaClient,
  now: Date,
  options: { batchSize?: number } = {},
): Promise<Array<{ id: string; reason: CloseReason }>> {
  const batchSize = options.batchSize ?? 200;
  const closing: Array<{ id: string; reason: CloseReason }> = [];
  const eligibleFor = new Map<string, Promise<string[]>>();
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.extApproval.findMany({
      where: { status: "pending", ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        spaceId: true,
        botId: true,
        runId: true,
        requestedBy: true,
        approverIds: true,
        expiresAt: true,
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    const ended = new Set(
      (
        await prisma.run.findMany({
          where: { id: { in: page.map((row) => row.runId) }, status: { in: ENDED_RUN_STATUSES } },
          select: { id: true },
        })
      ).map((run) => run.id),
    );
    for (const row of page) {
      if (isApprovalExpired(row.expiresAt, now)) {
        closing.push({ id: row.id, reason: "expired" });
        continue;
      }
      if (ended.has(row.runId)) {
        closing.push({ id: row.id, reason: "run_ended" });
        continue;
      }
      const key = `${row.spaceId}:${row.botId}:${row.requestedBy}`;
      let eligible = eligibleFor.get(key);
      if (!eligible) {
        eligible = eligibleApprovers(prisma, row);
        eligibleFor.set(key, eligible);
      }
      if (activeApprovers(row.approverIds, await eligible).length === 0) {
        closing.push({ id: row.id, reason: "no_approver" });
      }
    }
    if (page.length < batchSize) break;
    cursor = page.at(-1)!.id;
  }
  return closing;
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

/**
 * The API records the EXT_APPROVALS value it runs with. A worker that disagrees would run
 * gated calls without approval (or wait on approvals nobody serves), so it refuses to start.
 */
export async function recordApprovalsFlag(prisma: PrismaClient, enabled: boolean): Promise<void> {
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default", extApprovals: enabled },
    update: { extApprovals: enabled },
  });
}

export async function assertApprovalsFlag(prisma: PrismaClient, enabled: boolean): Promise<void> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { extApprovals: true },
  });
  const recorded = settings?.extApprovals;
  if (recorded === null || recorded === undefined) return;
  if (recorded !== enabled) {
    const flag = (value: boolean) => (value ? "1" : "0");
    throw new Error(
      `EXT_APPROVALS is ${flag(enabled)} in the worker but ${flag(recorded)} in the API; set the same value for both`,
    );
  }
}

export type ApprovalCardRow = {
  id: string;
  approvalId: string;
  kind: string;
  userId: string;
  identityId: string;
  provider: string;
  threadId: string;
  messageId: string | null;
};

/**
 * Reserve the card (or notice) for one identity before posting it, so a request announced
 * twice never posts twice. Null when it is already there.
 */
export async function claimApprovalCard(
  prisma: PrismaClient,
  input: Omit<ApprovalCardRow, "id" | "messageId">,
): Promise<string | null> {
  const id = randomUUID();
  const created = await prisma.extApprovalCard.createMany({
    data: [{ id, ...input }],
    skipDuplicates: true,
  });
  return created.count === 1 ? id : null;
}

export async function approvalCards(
  prisma: PrismaClient,
  approvalId: string,
): Promise<ApprovalCardRow[]> {
  return prisma.extApprovalCard.findMany({ where: { approvalId }, orderBy: { createdAt: "asc" } });
}

export async function setApprovalCardMessage(
  prisma: PrismaClient,
  cardId: string,
  messageId: string,
): Promise<void> {
  await prisma.extApprovalCard.update({ where: { id: cardId }, data: { messageId } });
}

/** A card that could not be posted is released, so a later announcement can try again. */
export async function releaseApprovalCard(prisma: PrismaClient, cardId: string): Promise<void> {
  await prisma.extApprovalCard.delete({ where: { id: cardId } });
}
