import { randomUUID } from "node:crypto";
import type {
  MessagingCommand,
  MessagingInboundMessage,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { notifyStoppedThreads, toTeamChatInbound } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  formatPausedReply,
  parseControlCommand,
  parseMessagingCommand,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type {
  ActiveStop,
  ControlScope,
  EmergencyStopReader,
  PrismaClient,
  StopTarget,
  ThreadEvents,
} from "@rakazo/db";
import {
  AuditWriteError,
  CONTROL_SCOPES,
  cancelRunsForStop,
  getAuditWriter,
  recordResume,
  recordStop,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";

/**
 * Fork extension: emergency stop and resume (EXT_EMERGENCY_STOP), spec in
 * docs/governance/emergency-stop.md. The space always comes from the
 * authenticated session or the verified chat identity, never from input.
 */

export const CONTROL_API_PATHS = {
  stop: "/api/v1/control/stop",
  resume: "/api/v1/control/resume",
  state: "/api/v1/control/state",
} as const;

/** Statuses the API cancels outright; `running` runs are halted by their worker's guard. */
const NOT_EXECUTING_STATUSES = ["queued", "leased", "waiting_input", "waiting_takeover"] as const;
const MAX_REASON = 500;
const REFUSAL = "Only an owner of this space can do that.";

export type ControlPrincipal = Pick<Actor, "userId" | "spaceId" | "isDeploymentOwner">;

export interface ControlRequest {
  scope: ControlScope;
  botId?: string;
  reason: string;
}

export interface StopView {
  id: string;
  scope: ControlScope;
  botId: string | null;
  reason: string;
  stoppedAt: string;
  stoppedBy: { id: string; name: string };
}

export interface ControlStateView {
  /** The session user may stop and resume this space and its bots. */
  canControl: boolean;
  /** The session user may stop and resume the whole deployment. */
  canControlGlobal: boolean;
  /** Active stops visible from the session space: global ones and its own. */
  stops: StopView[];
}

export interface ControlService {
  stop(
    principal: ControlPrincipal,
    request: ControlRequest,
  ): Promise<{ stop: StopView; error_id?: string }>;
  resume(principal: ControlPrincipal, request: ControlRequest): Promise<{ resumed: number }>;
  state(principal: ControlPrincipal): Promise<ControlStateView>;
}

/** An expected refusal; the message is safe to return as is. */
export class ControlError extends Error {
  readonly status: 400 | 403 | 404;

  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "ControlError";
    this.status = status;
  }
}

type ControlPrisma = Pick<
  PrismaClient,
  "$transaction" | "spaceMember" | "bot" | "user" | "messagingIdentity" | "deploymentSettings"
>;

function deny(principal: ControlPrincipal, scope: ControlScope, reason: string): ControlError {
  getLogger().warn("emergency stop denied", {
    "user.id": principal.userId,
    "space.id": principal.spaceId,
    "control.scope": scope,
    reason,
  });
  return new ControlError(403, "Forbidden");
}

async function isSpaceOwner(
  prisma: Pick<PrismaClient, "spaceMember">,
  principal: ControlPrincipal,
): Promise<boolean> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: principal.spaceId, userId: principal.userId } },
    select: { role: true },
  });
  return Boolean(
    membership?.role
      .split(",")
      .map((role) => role.trim())
      .includes("owner"),
  );
}

/**
 * Default deny. `global` is for the deployment owner only; `space` and `bot`
 * need the owner role in the session space (being the deployment owner does
 * not make someone an owner of a space they merely belong to).
 */
export async function authorizeControl(
  prisma: Pick<PrismaClient, "spaceMember">,
  principal: ControlPrincipal,
  scope: ControlScope,
): Promise<void> {
  if (scope === "global") {
    if (!principal.isDeploymentOwner) throw deny(principal, scope, "not the deployment owner");
    return;
  }
  if (!(await isSpaceOwner(prisma, principal))) throw deny(principal, scope, "not a space owner");
}

/** The stop target in the session space; another space's bot is "not found". */
export async function resolveControlTarget(
  prisma: Pick<PrismaClient, "bot">,
  principal: ControlPrincipal,
  request: ControlRequest,
): Promise<StopTarget & { botName: string | null }> {
  if (request.scope === "global") {
    return { scope: "global", spaceId: null, botId: null, botName: null };
  }
  if (request.scope === "space") {
    return { scope: "space", spaceId: principal.spaceId, botId: null, botName: null };
  }
  if (!request.botId) throw new ControlError(400, "botId is required for scope bot");
  const bot = await prisma.bot.findFirst({
    where: { id: request.botId, spaceId: principal.spaceId },
    select: { id: true, name: true },
  });
  if (!bot) {
    getLogger().warn("emergency stop target not found", {
      "user.id": principal.userId,
      "space.id": principal.spaceId,
    });
    throw new ControlError(404, "Not found");
  }
  return { scope: "bot", spaceId: principal.spaceId, botId: bot.id, botName: bot.name };
}

/** The spec body; any `spaceId` (or other key) is dropped. */
export function parseControlBody(body: unknown): ControlRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const { scope, botId, reason } = body as Record<string, unknown>;
  if (typeof scope !== "string" || !(CONTROL_SCOPES as readonly string[]).includes(scope)) {
    return { error: "scope must be bot, space or global" };
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed || trimmed.length > MAX_REASON) {
    return { error: `reason is required (at most ${MAX_REASON} characters)` };
  }
  if (scope === "bot") {
    if (typeof botId !== "string" || !botId) return { error: "botId is required for scope bot" };
    return { scope, botId, reason: trimmed };
  }
  return { scope: scope as ControlScope, reason: trimmed };
}

function scopeLabel(target: { scope: ControlScope; botName?: string | null }): string {
  if (target.scope === "global") return "every bot in the deployment";
  if (target.scope === "space") return "every bot in the space";
  return `bot ${target.botName ?? ""}`.trim();
}

async function userNames(
  prisma: Pick<PrismaClient, "user">,
  ids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(ids)) {
    const user = await prisma.user.findUnique({ where: { id }, select: { name: true } });
    names.set(id, user?.name ?? "");
  }
  return names;
}

function toView(stop: ActiveStop, names: Map<string, string>): StopView {
  return {
    id: stop.id,
    scope: stop.scope,
    botId: stop.botId,
    reason: stop.reason,
    stoppedAt: stop.stoppedAt.toISOString(),
    stoppedBy: { id: stop.stoppedBy, name: names.get(stop.stoppedBy) ?? "" },
  };
}

export function createControlService(deps: {
  prisma: ControlPrisma;
  reader: EmergencyStopReader;
  events: Pick<ThreadEvents, "notify">;
  /** Best-effort: pause (not destroy) the scope's computers. */
  pauseComputers?: (target: StopTarget, runIds: string[]) => Promise<void>;
  /** Best-effort: ask the scope's running cloud agents to cancel. */
  cancelCloudAgents?: (target: StopTarget) => Promise<unknown>;
}): ControlService {
  const { prisma, reader } = deps;
  const forget = (target: StopTarget) => reader.invalidate(target.spaceId ?? undefined);

  return {
    async stop(principal, request) {
      await authorizeControl(prisma, principal, request.scope);
      const target = await resolveControlTarget(prisma, principal, request);
      const scopeFilter = {
        ...(target.spaceId ? { spaceId: target.spaceId } : {}),
        ...(target.botId ? { botId: target.botId } : {}),
      };
      const { stop, created } = await recordStop(prisma, {
        scope: target.scope,
        spaceId: target.spaceId,
        botId: target.botId,
        reason: request.reason,
        userId: principal.userId,
      });
      forget(target);
      // The brake holds from here on: the cancellations, the audit record and
      // the computer pause below are follow-ups that must not undo it.
      let cancelledRunIds: string[] = [];
      try {
        const cancelled = await cancelRunsForStop(prisma, {
          ...scopeFilter,
          statuses: NOT_EXECUTING_STATUSES,
        });
        cancelledRunIds = cancelled.runIds;
        await notifyStoppedThreads(deps.events, cancelled.threads);
      } catch (error) {
        // Run start re-checks the stop, so a queued run left here still never executes.
        getLogger().error("emergency stop could not cancel queued runs", error, {
          "space.id": principal.spaceId,
        });
      }
      let errorId: string | undefined;
      const audit = getAuditWriter();
      if (audit) {
        try {
          await audit.record({
            spaceId: principal.spaceId,
            botId: target.botId,
            actor: { type: "human", id: principal.userId },
            kind: "control.stop",
            summary: `Stopped ${scopeLabel(target)}: ${request.reason}`,
            detail: {
              scope: target.scope,
              botId: target.botId,
              stopId: stop.id,
              reason: request.reason,
              alreadyStopped: !created,
              cancelledRuns: cancelledRunIds.length,
            },
          });
        } catch (error) {
          // Fail safe for a brake: the stop stays in effect, loudly.
          const failure = AuditWriteError.from(error);
          errorId = failure.errorRef;
          getLogger().error("emergency stop is in effect but its audit record failed", failure, {
            "error.id": errorId,
            "space.id": principal.spaceId,
            "control.scope": target.scope,
          });
        }
      }
      await deps
        .cancelCloudAgents?.(target)
        .catch((error) => getLogger().error("emergency stop could not cancel cloud agents", error));
      // Running runs pause their own computer once their in-flight tool call is done.
      await deps
        .pauseComputers?.(target, cancelledRunIds)
        .catch((error) => getLogger().error("emergency stop could not pause computers", error));
      const names = await userNames(prisma, [stop.stoppedBy]);
      return { stop: toView(stop, names), ...(errorId ? { error_id: errorId } : {}) };
    },

    async resume(principal, request) {
      await authorizeControl(prisma, principal, request.scope);
      const target = await resolveControlTarget(prisma, principal, request);
      const audit = getAuditWriter();
      // Fail closed: the resume commits only together with its audit record.
      const resumed = await recordResume(
        prisma,
        {
          scope: target.scope,
          spaceId: target.spaceId,
          botId: target.botId,
          userId: principal.userId,
        },
        async (tx, rows) => {
          await audit?.recordInTransaction(tx, {
            spaceId: principal.spaceId,
            botId: target.botId,
            actor: { type: "human", id: principal.userId },
            kind: "control.resume",
            summary: `Resumed ${scopeLabel(target)}: ${request.reason}`,
            detail: {
              scope: target.scope,
              botId: target.botId,
              stopIds: rows.map((row) => row.id),
              reason: request.reason,
            },
          });
        },
      );
      forget(target);
      return { resumed: resumed.length };
    },

    async state(principal) {
      const [canControl, stops] = await Promise.all([
        isSpaceOwner(prisma, principal),
        reader.activeStops(principal.spaceId),
      ]);
      const names = await userNames(
        prisma,
        stops.map((stop) => stop.stoppedBy),
      );
      return {
        canControl,
        canControlGlobal: principal.isDeploymentOwner,
        stops: stops.map((stop) => toView(stop, names)),
      };
    },
  };
}

/** `POST /api/v1/control/stop`, `POST /api/v1/control/resume`, `GET /api/v1/control/state`. */
export function mountControlRoutes(
  app: Hono,
  deps: {
    service: ControlService;
    authenticate: (request: Request) => Promise<ControlPrincipal | null>;
  },
): void {
  const principalOf = async (request: Request): Promise<ControlPrincipal | null> => {
    const actor = await deps.authenticate(request);
    if (!actor) {
      getLogger().warn("emergency stop request without a session", {
        "http.path": new URL(request.url).pathname,
      });
      return null;
    }
    return {
      userId: actor.userId,
      spaceId: actor.spaceId,
      isDeploymentOwner: actor.isDeploymentOwner,
    };
  };

  const respond = async (run: () => Promise<unknown>) => {
    try {
      return Response.json(await run(), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ControlError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      const errorId = error instanceof AuditWriteError ? error.errorRef : randomUUID();
      if (!(error instanceof AuditWriteError)) {
        getLogger().error("emergency stop request failed", error, { "error.id": errorId });
      }
      return Response.json({ error: "Internal error", error_id: errorId }, { status: 500 });
    }
  };

  for (const action of ["stop", "resume"] as const) {
    app.post(CONTROL_API_PATHS[action], async (c) => {
      const principal = await principalOf(c.req.raw);
      if (!principal) return c.json({ error: "Unauthorized" }, 401);
      // JSON only: a cross-site form post cannot reach this without a CORS preflight.
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        return c.json({ error: "Content-Type must be application/json" }, 415);
      }
      const body = parseControlBody(await c.req.json().catch(() => undefined));
      if ("error" in body) return c.json({ error: body.error }, 400);
      return respond(() => deps.service[action](principal, body));
    });
  }
  app.get(CONTROL_API_PATHS.state, async (c) => {
    const principal = await principalOf(c.req.raw);
    if (!principal) return c.json({ error: "Unauthorized" }, 401);
    return respond(() => deps.service.state(principal));
  });
}

/**
 * Chat side: `/stop`, `/stop <bot>`, `/resume <bot>` and `/resume` from a
 * linked owner, and the paused reply for messages to a stopped bot. Runs
 * before any routing, so it works while the bot is stopped and nothing it
 * consumes ever creates a run.
 */
export function createChatControl(deps: {
  prisma: ControlPrisma;
  reader: EmergencyStopReader;
  service: ControlService;
  messaging: Pick<MessagingSurface, "sendToThread">;
  /** The team-chat bot this message reaches when it rides the team-chat path, else null. */
  teamChatBotFor: (event: MessagingInboundMessage) => string | null;
}): {
  intercept(event: MessagingInboundMessage): Promise<boolean>;
  /** A platform slash command (/stop, /resume); replies go only to the sender. */
  handleCommand(command: MessagingCommand): Promise<void>;
} {
  const { prisma, reader, service } = deps;

  const reply = async (event: MessagingInboundMessage, body: string) => {
    const operationId = `ext-control:${randomUUID()}`;
    try {
      await deps.messaging.sendToThread(
        {
          threadId: event.threadId,
          body,
          idempotencyKey: `ext-control:${event.provider}:${event.handle}`,
        },
        {
          operationId,
          traceId: operationId,
          spaceId: "",
          userId: "",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      getLogger().error("emergency stop chat reply failed", error);
    }
  };

  const linkedIdentity = (sender: { provider: string; from: string }) =>
    prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider: sender.provider, address: sender.from } },
      select: { userId: true, spaceId: true, botId: true },
    });

  const replyPaused = async (event: MessagingInboundMessage, stop: ActiveStop) => {
    const user = await prisma.user.findUnique({
      where: { id: stop.stoppedBy },
      select: { name: true },
    });
    await reply(event, formatPausedReply({ name: user?.name ?? "", at: stop.stoppedAt }));
  };

  /** Shared by typed commands and platform slash commands; `answer` replies to the sender. */
  const runCommand = async (
    sender: { provider: string; from: string },
    command: NonNullable<ReturnType<typeof parseControlCommand>>,
    answer: (body: string) => Promise<void>,
  ) => {
    const identity = await linkedIdentity(sender);
    if (!identity) {
      getLogger().warn("emergency stop chat command from an unlinked sender", {
        "messaging.provider": sender.provider,
      });
      await answer(REFUSAL);
      return;
    }
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    const principal: ControlPrincipal = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      isDeploymentOwner: settings?.ownerUserId === identity.userId,
    };
    try {
      await authorizeControl(prisma, principal, command.botName ? "bot" : "space");
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      await answer(REFUSAL);
      return;
    }
    let bot: { id: string; name: string } | null = null;
    if (command.botName) {
      bot = await prisma.bot.findFirst({
        where: {
          spaceId: principal.spaceId,
          archivedAt: null,
          name: { equals: command.botName, mode: "insensitive" },
        },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      });
      if (!bot) {
        await answer(`No bot named "${sanitizeMessagingLabel(command.botName)}" here.`);
        return;
      }
    }
    const reason = `/${command.action} from ${sender.provider}`;
    const request: ControlRequest = bot
      ? { scope: "bot", botId: bot.id, reason }
      : { scope: "space", reason };
    try {
      if (command.action === "stop") {
        await service.stop(principal, request);
        await answer(bot ? `Stopped ${bot.name}.` : "Stopped every bot in this space.");
        return;
      }
      const { resumed } = await service.resume(principal, request);
      await answer(
        resumed
          ? bot
            ? `Resumed ${bot.name}.`
            : "Resumed this space."
          : bot
            ? `${bot.name} was not stopped.`
            : "This space was not stopped.",
      );
    } catch (error) {
      if (error instanceof ControlError) {
        await answer(error.status === 403 ? REFUSAL : "Not found.");
        return;
      }
      const errorId = error instanceof AuditWriteError ? error.errorRef : randomUUID();
      if (!(error instanceof AuditWriteError)) {
        getLogger().error("emergency stop chat command failed", error, { "error.id": errorId });
      }
      await answer(`Internal error (error_id: ${errorId})`);
    }
  };

  const interceptPaused = async (event: MessagingInboundMessage): Promise<boolean> => {
    const teamBotId = deps.teamChatBotFor(event);
    if (teamBotId) {
      const bot = await prisma.bot.findUnique({
        where: { id: teamBotId },
        select: { id: true, spaceId: true },
      });
      if (!bot) return false;
      const stop = await reader.check({ spaceId: bot.spaceId, botId: bot.id });
      if (!stop) return false;
      // Ambient room talk was never addressed to the bot: stay silent rather than spam the room.
      const kind = event.isDirect ? "direct" : (toTeamChatInbound(event)?.kind ?? "ambient");
      if (kind !== "ambient" && !event.senderIsBot) await replyPaused(event, stop);
      return true;
    }
    // Personal-line groups fan out per member; stopped bots sit out there (messaging-inbound).
    if (!event.isDirect) return false;
    // Owner YES/NO/LEAVE answers are not messages to the bot and never start a run.
    if (parseMessagingCommand(event.content)) return false;
    const identity = await linkedIdentity(event);
    if (!identity) return false;
    const stop = await reader.check({ spaceId: identity.spaceId, botId: identity.botId });
    if (!stop) return false;
    await replyPaused(event, stop);
    return true;
  };

  return {
    async intercept(event) {
      const command = parseControlCommand(event.content);
      if (command) {
        if (event.senderIsBot) return false;
        await runCommand(event, command, (body) => reply(event, body));
        return true;
      }
      return interceptPaused(event);
    },
    async handleCommand(slash) {
      const command = parseControlCommand(`${slash.command} ${slash.text}`.trim());
      if (!command) return;
      await runCommand(slash, command, async (body) => {
        try {
          await slash.respond(body);
        } catch (error) {
          getLogger().error("emergency stop slash command reply failed", error);
        }
      });
    },
  };
}
