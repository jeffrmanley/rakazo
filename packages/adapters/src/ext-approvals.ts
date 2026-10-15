import { randomUUID } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { ApprovalOutcome, RiskClass } from "@rakazo/core";
import { approvalRequired, isRiskClass, toolRiskClass } from "@rakazo/core";
import type { ApprovalRequestInput, ApprovalRow, PrismaClient } from "@rakazo/db";
import {
  checkApprovedCall,
  createApprovalRequest,
  loadApprovalPolicy,
  replyMessagingIdentity,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ApprovalCardInput } from "./ext-approval-card.js";
import { buildApprovalDecidedCard, buildApprovalRequestCard } from "./ext-approval-card.js";

/**
 * Fork extension: approvals (EXT_APPROVALS), spec in docs/governance/approvals.md.
 * The run side: which calls wait for a person, the request with its audit record, the chat
 * card, and the execution-time check of the approval. Composition roots install it when the
 * flag is on; with none installed the executor behaves exactly as upstream.
 */
export interface ApprovalModule {
  /** The call's risk class when the bot's policy makes it wait for a person, else null. */
  gate(input: {
    spaceId: string;
    botId: string;
    toolName: string;
    viaConnector: boolean;
    readOnly?: boolean;
  }): Promise<RiskClass | null>;
  /** Persist the request and its `approval.request` record; throws (fail closed) if either fails. */
  request(input: ApprovalRequestInput): Promise<ApprovalRow>;
  /** Post the approval card to the run's chat, best effort (the web card always exists). */
  announce(approvalId: string): Promise<void>;
  /** Null when an approved call may run now; otherwise the refusal the model sees. */
  checkExecution(input: { effectId: string; callHash: string }): Promise<string | null>;
}

let installed: ApprovalModule | null = null;

export function installApprovals(module: ApprovalModule | null): void {
  installed = module;
}

export function getApprovals(): ApprovalModule | null {
  return installed;
}

export interface ApprovalCardDeps {
  prisma: PrismaClient;
  messaging?: Pick<
    MessagingSurface,
    "cardProviders" | "sendCard" | "updateCard" | "openDirectThread"
  >;
}

export function createApprovalModule(deps: ApprovalCardDeps): ApprovalModule {
  return {
    async gate(input) {
      const riskClass = toolRiskClass(input);
      const policy = await loadApprovalPolicy(deps.prisma, input);
      return approvalRequired(policy, riskClass) ? riskClass : null;
    },
    request: (input) => createApprovalRequest(deps.prisma, input),
    announce: (approvalId) => postApprovalCard(deps, approvalId),
    async checkExecution(input) {
      return (await checkApprovedCall(deps.prisma, input)).refusal;
    },
  };
}

function cardContext(): AdapterContext {
  const operationId = `ext-approvals:${randomUUID()}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: "",
    userId: "",
    signal: AbortSignal.timeout(10_000),
  };
}

async function cardInput(prisma: PrismaClient, row: ApprovalRow): Promise<ApprovalCardInput> {
  const bot = await prisma.bot.findUnique({ where: { id: row.botId }, select: { name: true } });
  return {
    approvalId: row.id,
    botName: bot?.name ?? "Bot",
    toolName: row.toolName,
    riskClass: isRiskClass(row.riskClass) ? row.riskClass : "write-external",
    args: row.args,
    reason: row.reason,
    expiresAt: row.expiresAt,
  };
}

/**
 * Post the card where the run's conversation lives: the chat app the run came from, else
 * the bot's home identity; platforms without cards (and runs with neither) stay web only.
 */
export async function postApprovalCard(deps: ApprovalCardDeps, approvalId: string): Promise<void> {
  const messaging = deps.messaging;
  if (!messaging?.sendCard || !messaging.cardProviders) return;
  try {
    const row = await deps.prisma.extApproval.findUnique({ where: { id: approvalId } });
    if (!row || row.cardMessageId) return;
    const run = await deps.prisma.run.findUnique({
      where: { id: row.runId },
      select: { botId: true, messagingIdentityId: true },
    });
    if (!run) return;
    const identity = await replyMessagingIdentity(deps.prisma, run);
    if (!identity || !messaging.cardProviders().includes(identity.provider)) return;
    const context = cardContext();
    const threadId =
      identity.dmThreadId ??
      (await messaging.openDirectThread(identity.provider, identity.address, context));
    const input = await cardInput(deps.prisma, row);
    const sent = await messaging.sendCard(threadId, buildApprovalRequestCard(input), context);
    const claimed = await deps.prisma.extApproval.updateMany({
      where: { id: row.id, cardMessageId: null },
      data: { cardProvider: identity.provider, cardThreadId: threadId, cardMessageId: sent.handle },
    });
    if (claimed.count !== 1) return;
    // Decided while the card was on its way: show the outcome right away.
    const current = await deps.prisma.extApproval.findUnique({ where: { id: row.id } });
    if (current && current.status !== "pending") await refreshApprovalCard(deps, current);
  } catch (error) {
    getLogger().error("approval card could not be posted", error, { "approval.id": approvalId });
  }
}

/** Replace a decided request's chat card with its outcome (best effort). */
export async function refreshApprovalCard(
  deps: ApprovalCardDeps,
  row: ApprovalRow,
  deciderName?: string,
): Promise<void> {
  const messaging = deps.messaging;
  if (!messaging?.updateCard || !row.cardThreadId || !row.cardMessageId) return;
  if (row.status === "pending") return;
  try {
    let byName = deciderName;
    if (byName === undefined && row.decidedBy) {
      byName =
        (
          await deps.prisma.user.findUnique({
            where: { id: row.decidedBy },
            select: { name: true },
          })
        )?.name ?? undefined;
    }
    const card = buildApprovalDecidedCard(await cardInput(deps.prisma, row), {
      outcome: row.status as ApprovalOutcome,
      byName,
    });
    await messaging.updateCard(row.cardThreadId, row.cardMessageId, card, cardContext());
  } catch (error) {
    getLogger().error("approval card could not be updated", error, { "approval.id": row.id });
  }
}
