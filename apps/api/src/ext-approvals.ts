import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { JobPublisher, MessagingAction, MessagingSurface } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { APPROVAL_ACTIONS, APPROVAL_ALLOW_ACTION, refreshApprovalCard } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { DEFAULT_GATED_CLASSES, parseApprovalPolicyPatch, RISK_CLASSES } from "@rakazo/core";
import type {
  ApprovalDecider,
  ApprovalVia,
  DecideApprovalResult,
  PrismaClient,
  ThreadEvents,
} from "@rakazo/db";
import {
  AuditWriteError,
  CLOSE_NOTES,
  decideApproval,
  findApprovalsToClose,
  getAuditWriter,
  isSpaceOwner,
  loadApprovalPolicy,
  loadSpaceRoster,
  saveApprovalPolicy,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";

/**
 * Fork extension: approvals (EXT_APPROVALS), spec in docs/governance/approvals.md. Created
 * only with the flag on: then the web card, Slack and Teams buttons and the expiry sweep
 * all decide through `decideApproval`, and bot settings gain the approval policy.
 */

export const APPROVALS_API_PATH = "/api/v1/approvals";
const SWEEP_INTERVAL_MS = 15_000;
const NOT_ALLOWED = "You can't decide this approval.";
const ALREADY_DECIDED = "This approval was already decided.";

export interface ApprovalService {
  /**
   * The web card's answer for a call the approval policy gates; false when the pending ask
   * is not one (it then takes the upstream path unchanged).
   */
  answerFromWeb(
    actor: Pick<Actor, "userId" | "spaceId">,
    input: { threadId: string; runId: string; messageId: string; answer: string },
  ): Promise<boolean>;
  /** A Slack or Teams button click; the clicker comes from the verified request only. */
  handleChatAction(action: MessagingAction): Promise<void>;
  /** Close expired requests and those without an approver left. Returns how many. */
  sweep(now?: Date): Promise<number>;
  /** Sweep on an interval until the returned function is called. */
  start(): () => void;
}

export function createApprovalService(deps: {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  messaging?: MessagingSurface;
  now?: () => Date;
}): ApprovalService {
  const now = deps.now ?? (() => new Date());

  const decide = async (
    input: Parameters<typeof decideApproval>[1],
    deciderName?: string,
  ): Promise<DecideApprovalResult> => {
    const result = await decideApproval(
      deps.prisma,
      { ...input, now: input.now ?? now() },
      (t, s) => deps.events.notify(t, s),
    );
    if (result.status !== "decided") return result;
    if (result.resumed) {
      await deps.jobs.enqueue(runContinueJob(result.approval.runId)).catch((error) => {
        // The resume is durable; the reconciler repairs a missed immediate wake.
        getLogger().error("approval resume enqueue", error);
      });
    }
    await refreshApprovalCard(
      { prisma: deps.prisma, messaging: deps.messaging },
      result.approval,
      deciderName,
    );
    return result;
  };

  const sweep = async (at = now()): Promise<number> => {
    const due = await findApprovalsToClose(deps.prisma, at);
    let closed = 0;
    for (const item of due) {
      try {
        const result = await decide({
          approvalId: item.id,
          decider: { type: "system" },
          answer: "deny",
          via: "system",
          now: at,
          ...(item.reason === "expired" ? {} : { note: CLOSE_NOTES[item.reason] }),
        });
        if (result.status === "decided") closed += 1;
      } catch (error) {
        // Fail closed: the request stays pending (nothing runs) and the next sweep retries.
        getLogger().error("approval sweep failed", error, { "approval.id": item.id });
      }
    }
    return closed;
  };

  return {
    async answerFromWeb(actor, input) {
      const message = await deps.prisma.message.findFirst({
        where: { id: input.messageId, threadId: input.threadId, runId: input.runId, role: "bot" },
        select: { blocks: true },
      });
      const ask = ((message?.blocks ?? []) as MessageBlock[]).find(
        (block) => block.kind === "ask" && block.status !== "answered" && block.approvalEffectId,
      );
      if (ask?.kind !== "ask" || !ask.approvalEffectId) return false;
      const gated = await deps.prisma.extApproval.findFirst({
        where: { effectId: ask.approvalEffectId, spaceId: actor.spaceId },
        select: { id: true },
      });
      if (!gated) return false;
      if (input.answer !== "allow" && input.answer !== "deny") {
        throw new ORPCError("BAD_REQUEST", { message: "Choose allow or deny" });
      }
      const result = await decide({
        approvalId: gated.id,
        spaceId: actor.spaceId,
        decider: { type: "human", userId: actor.userId },
        answer: input.answer,
        via: "web",
      });
      if (result.status === "decided") return true;
      if (result.status === "not_allowed" || result.status === "not_found") {
        throw new ORPCError("FORBIDDEN", { message: NOT_ALLOWED });
      }
      throw new ORPCError("CONFLICT", { message: "This prompt is no longer awaiting an answer" });
    },

    async handleChatAction(action) {
      if (!APPROVAL_ACTIONS.includes(action.actionId)) return;
      const reply = async (body: string) => {
        try {
          await action.respond(body);
        } catch (error) {
          getLogger().error("approval chat reply failed", error);
        }
      };
      const approvalId = action.value.trim();
      // Identity from the verified request only: provider + sender address -> linked
      // identity -> user. The button value only names the request.
      const identity = await deps.prisma.messagingIdentity.findUnique({
        where: { provider_address: { provider: action.provider, address: action.from } },
        select: { userId: true },
      });
      if (!identity || !approvalId || approvalId.length > 100) {
        getLogger().warn("approval click from an unlinked sender", {
          "messaging.provider": action.provider,
          "approval.id": approvalId.slice(0, 100),
        });
        await reply(NOT_ALLOWED);
        return;
      }
      const decider: ApprovalDecider = { type: "human", userId: identity.userId };
      const user = await deps.prisma.user.findUnique({
        where: { id: identity.userId },
        select: { name: true },
      });
      let result: DecideApprovalResult;
      try {
        result = await decide(
          {
            approvalId,
            decider,
            answer: action.actionId === APPROVAL_ALLOW_ACTION ? "allow" : "deny",
            via: action.provider as ApprovalVia,
            interactionId: action.handle,
          },
          user?.name,
        );
      } catch (error) {
        const errorId = error instanceof AuditWriteError ? error.errorRef : randomUUID();
        if (!(error instanceof AuditWriteError)) {
          getLogger().error("approval chat decision failed", error, { "error.id": errorId });
        }
        await reply(`Internal error (error_id: ${errorId})`);
        return;
      }
      if (result.status === "already_decided") await reply(ALREADY_DECIDED);
      else if (result.status !== "decided") await reply(NOT_ALLOWED);
    },

    sweep,

    start() {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        void sweep()
          .catch((error) => getLogger().error("approval sweep failed", error))
          .finally(() => {
            running = false;
          });
      }, SWEEP_INTERVAL_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** Clicks on approval cards from the messaging surface go to the service. */
export function mountApprovalActions(messaging: MessagingSurface, service: ApprovalService): void {
  messaging.onAction?.(APPROVAL_ACTIONS, (action) => service.handleChatAction(action));
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Per-bot approval policy (EXT_APPROVALS). Mounted only with the flag on. The space is the
 * session's; a spaceId in the body or query is ignored. Space owners read and change it;
 * anyone else gets 404, exactly like a bot in another space. Changes are audited as
 * `policy.change` in the same transaction (fail closed).
 *
 * - `GET /api/v1/approvals/bots/:botId`  `{ policy, defaults, members }`
 * - `PUT /api/v1/approvals/bots/:botId`  `{ gatedClasses?, approverUserIds? }`
 */
export function mountApprovalRoutes(
  app: Hono,
  deps: { prisma: PrismaClient; authenticate: (request: Request) => Promise<Actor | null> },
): void {
  const route =
    (handler: (c: Context, actor: Actor) => Promise<Response>) => async (c: Context) => {
      const actor = await deps.authenticate(c.req.raw);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      c.header("cache-control", "no-store");
      try {
        return await handler(c, actor);
      } catch (error) {
        if (error instanceof HttpError) {
          getLogger().warn("approval policy request denied", {
            "user.id": actor.userId,
            "space.id": actor.spaceId,
            path: c.req.path,
            status: error.status,
          });
          return c.json({ error: error.message }, error.status);
        }
        const errorId = error instanceof AuditWriteError ? error.errorRef : randomUUID();
        if (!(error instanceof AuditWriteError)) {
          getLogger().error("approval policy request failed", error, { "error.id": errorId });
        }
        return c.json({ error: "Internal error", error_id: errorId }, 500);
      }
    };

  const ownedBot = async (actor: Actor, botId: string) => {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true },
    });
    if (!bot || !(await isSpaceOwner(deps.prisma, actor))) throw new HttpError(404, "Not found");
    return bot.id;
  };

  const view = async (actor: Actor, botId: string) => {
    const [policy, roster] = await Promise.all([
      loadApprovalPolicy(deps.prisma, { spaceId: actor.spaceId, botId }),
      loadSpaceRoster(deps.prisma, actor.spaceId),
    ]);
    return {
      policy,
      defaults: { gatedClasses: DEFAULT_GATED_CLASSES },
      riskClasses: RISK_CLASSES,
      members: roster.members,
    };
  };

  app.get(
    `${APPROVALS_API_PATH}/bots/:botId`,
    route(async (c, actor) =>
      c.json(await view(actor, await ownedBot(actor, c.req.param("botId") ?? ""))),
    ),
  );

  app.put(
    `${APPROVALS_API_PATH}/bots/:botId`,
    route(async (c, actor) => {
      const botId = await ownedBot(actor, c.req.param("botId") ?? "");
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "Expected a JSON object");
      }
      const parsed = parseApprovalPolicyPatch(body as Record<string, unknown>);
      if (!parsed.ok) throw new HttpError(400, parsed.error);
      await deps.prisma.$transaction(async (tx) => {
        if (parsed.value.approverUserIds?.length) {
          const roster = await loadSpaceRoster(tx, actor.spaceId);
          const members = new Set(roster.members.map((member) => member.userId));
          if (!parsed.value.approverUserIds.every((id) => members.has(id))) {
            throw new HttpError(400, "Approvers must be members of this space");
          }
        }
        const policy = await saveApprovalPolicy(tx, {
          spaceId: actor.spaceId,
          botId,
          actorId: actor.userId,
          patch: parsed.value,
        });
        await getAuditWriter()?.recordInTransaction(tx, {
          spaceId: actor.spaceId,
          botId,
          actor: { type: "human", id: actor.userId },
          kind: "policy.change",
          summary: "Bot approval policy changed",
          detail: { target: "approvals", ...policy },
        });
      });
      return c.json(await view(actor, botId));
    }),
  );
}
