import { randomUUID } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { ApprovalOutcome, RiskClass } from "@rakazo/core";
import {
  approvalRequired,
  isApprovalExempt,
  isRiskClass,
  sanitizeMessagingLabel,
  toolRiskClass,
} from "@rakazo/core";
import type { ApprovalRequestInput, ApprovalRow, PrismaClient } from "@rakazo/db";
import {
  approvalCards,
  checkApprovedCall,
  claimApprovalCard,
  createApprovalRequest,
  loadApprovalPolicy,
  releaseApprovalCard,
  setApprovalCardMessage,
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
    /** The MCP server a connector tool comes from, if any. */
    mcpServerId?: string;
  }): Promise<RiskClass | null>;
  /** Persist the request and its `approval.request` record; throws (fail closed) if either fails. */
  request(input: ApprovalRequestInput): Promise<ApprovalRow>;
  /** Post the approval cards to the approvers' chats, best effort (the web card always exists). */
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
    "cardProviders" | "sendCard" | "updateCard" | "openDirectThread" | "sendToThread"
  >;
}

export function createApprovalModule(deps: ApprovalCardDeps): ApprovalModule {
  return {
    async gate(input) {
      if (isApprovalExempt(input.toolName)) return null;
      // A tool server the model added itself is never trusted by tool names.
      const modelAdded = input.mcpServerId
        ? Boolean(
            (
              await deps.prisma.mcpServer.findFirst({
                where: { id: input.mcpServerId, spaceId: input.spaceId },
                select: { addedByBotId: true },
              })
            )?.addedByBotId,
          )
        : false;
      const riskClass = toolRiskClass({ ...input, modelAdded });
      const policy = await loadApprovalPolicy(deps.prisma, input);
      return approvalRequired(policy, riskClass) ? riskClass : null;
    },
    request: (input) => createApprovalRequest(deps.prisma, input),
    announce: (approvalId) => postApprovalCards(deps, approvalId),
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
    callHash: row.callHash,
    expiresAt: row.expiresAt,
  };
}

type CardIdentity = {
  id: string;
  userId: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  botId: string;
  lastInboundAt: Date | null;
  createdAt: Date;
};

/**
 * The chat identity an approver's card goes to: for the requester, the chat the run came
 * through; otherwise the bot's home identity, then an identity of this bot, then the one
 * the person used last. Only platforms that show cards.
 */
export function pickCardIdentity(
  identities: CardIdentity[],
  ctx: {
    userId: string;
    botId: string;
    homeId: string | null;
    runIdentity: CardIdentity | null;
    requesterId: string;
    providers: string[];
  },
): CardIdentity | null {
  const usable = identities.filter(
    (each) => each.userId === ctx.userId && ctx.providers.includes(each.provider),
  );
  const run = ctx.runIdentity;
  if (
    ctx.userId === ctx.requesterId &&
    run &&
    run.userId === ctx.userId &&
    ctx.providers.includes(run.provider)
  ) {
    return run;
  }
  return (
    usable.find((each) => each.id === ctx.homeId) ??
    usable.find((each) => each.botId === ctx.botId) ??
    [...usable].sort(
      (a, b) =>
        (b.lastInboundAt?.getTime() ?? 0) - (a.lastInboundAt?.getTime() ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )[0] ??
    null
  );
}

const IDENTITY_SELECT = {
  id: true,
  userId: true,
  provider: true,
  address: true,
  dmThreadId: true,
  botId: true,
  lastInboundAt: true,
  createdAt: true,
} as const;

/**
 * Post a card to each approver's linked chat (approvers without one decide in the web app),
 * and tell a requester who is not an approver that the call waits. Every card resolves the
 * same request; a decision anywhere updates them all. Best effort, never posted twice.
 */
export async function postApprovalCards(deps: ApprovalCardDeps, approvalId: string): Promise<void> {
  const messaging = deps.messaging;
  if (!messaging?.sendCard || !messaging.cardProviders) return;
  try {
    const row = await deps.prisma.extApproval.findUnique({ where: { id: approvalId } });
    if (row?.status !== "pending") return;
    const providers = messaging.cardProviders();
    const [run, bot] = await Promise.all([
      deps.prisma.run.findUnique({
        where: { id: row.runId },
        select: { botId: true, messagingIdentityId: true },
      }),
      deps.prisma.bot.findUnique({
        where: { id: row.botId },
        select: { name: true, homeMessagingIdentityId: true },
      }),
    ]);
    const runIdentity = run?.messagingIdentityId
      ? await deps.prisma.messagingIdentity.findFirst({
          where: { id: run.messagingIdentityId, botId: row.botId },
          select: IDENTITY_SELECT,
        })
      : null;
    const identitiesOf = (userId: string, cardsOnly: boolean) =>
      deps.prisma.messagingIdentity.findMany({
        where: {
          userId,
          spaceId: row.spaceId,
          ...(cardsOnly ? { provider: { in: providers } } : {}),
        },
        select: IDENTITY_SELECT,
        orderBy: { createdAt: "asc" },
      });
    const ctx = {
      botId: row.botId,
      homeId: bot?.homeMessagingIdentityId ?? null,
      runIdentity,
      requesterId: row.requestedBy,
    };
    const context = cardContext();
    const input = await cardInput(deps.prisma, row);
    const card = buildApprovalRequestCard(input);

    const post = async (
      identity: CardIdentity,
      kind: "approval" | "notice",
      send: (threadId: string) => Promise<{ handle: string }>,
    ) => {
      try {
        const threadId =
          identity.dmThreadId ??
          (await messaging.openDirectThread(identity.provider, identity.address, context));
        const cardId = await claimApprovalCard(deps.prisma, {
          approvalId: row.id,
          kind,
          userId: identity.userId,
          identityId: identity.id,
          provider: identity.provider,
          threadId,
        });
        if (!cardId) return;
        try {
          const sent = await send(threadId);
          await setApprovalCardMessage(deps.prisma, cardId, sent.handle);
        } catch (error) {
          await releaseApprovalCard(deps.prisma, cardId).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        getLogger().error("approval card could not be posted", error, {
          "approval.id": row.id,
          "messaging.provider": identity.provider,
        });
      }
    };

    for (const userId of row.approverIds) {
      const identity = pickCardIdentity(await identitiesOf(userId, true), {
        ...ctx,
        userId,
        providers,
      });
      if (identity) {
        await post(identity, "approval", (threadId) =>
          messaging.sendCard!(threadId, card, context),
        );
      }
    }
    if (!row.approverIds.includes(row.requestedBy) && messaging.sendToThread) {
      const requester =
        runIdentity?.userId === row.requestedBy
          ? runIdentity
          : ((await identitiesOf(row.requestedBy, false))[0] ?? null);
      if (requester) {
        const body = `${sanitizeMessagingLabel(input.botName)} is waiting for approval to run ${sanitizeMessagingLabel(row.toolName)}.`;
        await post(requester, "notice", (threadId) =>
          messaging.sendToThread!({ threadId, body }, context),
        );
      }
    }
    // Decided while the cards were on their way: show the outcome right away.
    const current = await deps.prisma.extApproval.findUnique({ where: { id: row.id } });
    if (current && current.status !== "pending") await refreshApprovalCards(deps, current);
  } catch (error) {
    getLogger().error("approval cards could not be posted", error, { "approval.id": approvalId });
  }
}

/** Replace every chat card of a decided request with its outcome (best effort). */
export async function refreshApprovalCards(
  deps: ApprovalCardDeps,
  row: ApprovalRow,
  deciderName?: string,
): Promise<void> {
  const messaging = deps.messaging;
  if (!messaging?.updateCard || row.status === "pending") return;
  try {
    const cards = (await approvalCards(deps.prisma, row.id)).filter(
      (card) => card.kind === "approval" && card.messageId,
    );
    if (cards.length === 0) return;
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
    for (const posted of cards) {
      await messaging
        .updateCard(posted.threadId, posted.messageId!, card, cardContext())
        .catch((error) =>
          getLogger().error("approval card could not be updated", error, {
            "approval.id": row.id,
            "messaging.provider": posted.provider,
          }),
        );
    }
  } catch (error) {
    getLogger().error("approval cards could not be updated", error, { "approval.id": row.id });
  }
}
